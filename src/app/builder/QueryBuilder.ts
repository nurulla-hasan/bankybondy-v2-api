import { FilterQuery, Query } from 'mongoose';
import { clampLimit, clampPage } from '../utilities/pagination';

// Escape regex metacharacters (anti-ReDoS / pattern injection).
const escapeRegex = (input: string): string =>
    input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class QueryBuilder<T> {
    // Identity/owner/sensitive-state fields never accepted from the query string in
    // filter(): the service fixes them in the base find. Prevents IDOR and state forcing.
    static readonly BLOCKED_FILTER_FIELDS: string[] = [
        'user',
        'receiver',
        'sender',
        'blocker',
        'blocked',
        'owner',
        'creator',
        'commentor',
        'addedBy',
        'participants',
        '_id',
        'id',
        'isBlocked',
        'moderationStatus',
        'isDeleted',
        'deleteBy',
        'seenBy',
        'isLinked',
        'isPause',
        'status',
        'isVerified',
        'accountStatus',
        'listedInPeople',
        'bondsPublic',
        'reputation',
        'subscriptionType',
        'bondLimit',
        'password',
        'verifyCode',
        'resetCode',
    ];
    // Fields never requestable via `?fields=`: embeddings, exact coordinates and secrets.
    // Services already exclude them with `.select('-...')`, but `?fields=offerVector,location`
    // overrode that. See fields().
    static readonly BLOCKED_PROJECTION_FIELDS: string[] = [
        'offerVector',
        'wantVector',
        'location',
        'password',
        'verifyCode',
        'resetCode',
    ];
    public modelQuery: Query<T[], T>;
    public query: Record<string, unknown>;
    constructor(modelQuery: Query<T[], T>, query: Record<string, unknown>) {
        this.modelQuery = modelQuery;
        this.query = query;
    }
    search(searchableFields: string[]) {
        const searchTerm = this?.query?.searchTerm;
        if (searchTerm) {
            const safe = escapeRegex(String(searchTerm));
            this.modelQuery = this?.modelQuery
                .find({
                    $or: searchableFields.map(
                        (field) =>
                            ({
                                [field]: { $regex: safe, $options: 'i' },
                            }) as FilterQuery<T>
                    ),
                })
                .maxTimeMS(3000);
        }
        return this;
    }
    filter(allowedFields: string[] = []) {
        const queryObj = { ...this.query };
        const excludeFields = ['searchTerm', 'sort', 'limit', 'page', 'fields'];
        excludeFields.forEach((el) => delete queryObj[el]);
        // SECURITY (IDOR / state forcing): mongoose overrides base `find` keys with query
        // string keys, so `?user=<other>` overwrote the owner scope of my-* endpoints and
        // `?moderationStatus=REJECTED` / `?isBlocked=false` forged states. Layer 1: global
        // denylist. Layer 2: an endpoint may opt in via `allowedFields` (e.g. admin audio
        // panel), safe ONLY when the base find has no owner scope; never in my-* endpoints.
        QueryBuilder.BLOCKED_FILTER_FIELDS.forEach((el) => {
            if (!allowedFields.includes(el)) delete queryObj[el];
        });
        this.modelQuery = this.modelQuery.find(queryObj as FilterQuery<T>);
        return this;
    }
    // sort() {
    //   const sort =
    //     (this?.query?.sort as string)?.split(',')?.join(' ') || '-createdAt';
    //   this.modelQuery = this.modelQuery.sort(sort as string);
    //   return this;
    // }

    sort() {
        // The old `as string` was a TypeScript lie: Express hands an ARRAY for a repeated
        // key (`?sort=a&sort=b`) and `.startsWith` throws. Even as a string the value hit
        // `$sort` raw (`?sort=$x` and `?sort=-` were both 500s); `sanitizeMongo` cleans
        // keys, not values. 21 mounted endpoints use this, so the fix lives here.
        const crudo = Array.isArray(this.query.sort)
            ? this.query.sort[0]
            : this.query.sort;
        const sortField = typeof crudo === 'string' ? crudo.trim() : '';

        // Acceptable shape: dot-separated segments each starting with a letter or underscore,
        // optional leading '-' for descending. Anything else falls back instead of breaking.
        // The naive `/^-?[A-Za-z_][A-Za-z0-9_.]*$/` still let `a.`, `a..b` and `a.b.` through
        // and Mongo rejected them (500), so the segment STRUCTURE is what closes it. Not an
        // allowlist: a well-formed unknown field just sorts by nothing (fails closed).
        const esCampoValido =
            /^-?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(
                sortField
            );

        if (esCampoValido) {
            const order = sortField.startsWith('-') ? -1 : 1;
            // Anchored: unanchored `replace('-','')` stripped the first dash anywhere,
            // corrupting a field with a mid-name dash.
            const fieldName = sortField.replace(/^-/, '');
            this.modelQuery = this.modelQuery.sort({ [fieldName]: order });
        } else {
            this.modelQuery = this.modelQuery.sort('-createdAt');
        }

        return this;
    }

    paginate() {
        // Safety cap: page/limit forced to positive ints and limit capped globally at 500,
        // because a raw Number(limit) let a user force huge queries (cheap DoS). 500, not
        // 100, because some callers legitimately ask 500 (e.g. all-audios filtered in the UI).
        const page = clampPage(this?.query.page);
        const limit = clampLimit(this?.query.limit);
        const skip = (page - 1) * limit;
        this.modelQuery = this.modelQuery.skip(skip).limit(limit);
        return this;
    }
    fields() {
        // Projection denylist: sensitive `?fields=` entries are dropped, otherwise
        // `?fields=offerVector,location` re-exposed what the service excludes (or broke with
        // "mixed projection"). If nothing survives, the previous default (`-_v`) is kept.
        // Same array issue as `sort()`: `?fields=a&fields=b` arrives as an ARRAY and
        // `.split` throws, so normalize to a comma-joined string. 19 endpoints use this.
        const crudoFields = this?.query?.fields;
        const raw = Array.isArray(crudoFields)
            ? crudoFields.filter((f) => typeof f === 'string').join(',')
            : typeof crudoFields === 'string'
              ? crudoFields
              : '';
        const cleaned = raw
            .split(',')
            .map((f) => f.trim())
            .filter(
                (f) =>
                    f &&
                    !QueryBuilder.BLOCKED_PROJECTION_FIELDS.includes(
                        f.replace(/^-/, '')
                    )
            )
            .join(' ');
        this.modelQuery = this.modelQuery.select(cleaned || '-_v') as any;
        return this;
    }
    async countTotal() {
        const totalQueries = this.modelQuery.getFilter();
        const total = await this.modelQuery.model.countDocuments(totalQueries);
        // Same clamps as paginate(): the metadata cannot drift from the real query
        // (it used to read the raw limit from the query string).
        const page = clampPage(this?.query?.page);
        const limit = clampLimit(this?.query?.limit);
        const totalPages = Math.ceil(total / limit);

        return {
            page,
            limit,
            total,
            totalPages,
        };
    }
}

export default QueryBuilder;
