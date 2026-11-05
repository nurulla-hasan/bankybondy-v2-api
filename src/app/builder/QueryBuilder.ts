import { FilterQuery, Query } from 'mongoose';
import { clampLimit, clampPage } from '../utilities/pagination';

// Escapa metacaracteres regex (anti ReDoS / inyeccion de patron).
const escapeRegex = (input: string): string =>
    input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class QueryBuilder<T> {
    // Campos de identidad/dueño/estado sensible que NUNCA se aceptan del query
    // string en filter() (el service los fija en el find base). Evita IDOR y
    // forzado de estado. Ver filter().
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
    // Campos que NUNCA se pueden pedir por `?fields=` (proyeccion). El cliente no
    // debe poder reexponer los vectores de embedding, las coordenadas exactas ni
    // secretos, aunque el service ya los excluya con `.select('-...')`: sin esto,
    // `?fields=offerVector,location` pisaba esa exclusion. Ver fields().
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
        const queryObj = { ...this.query }; // copy the query
        const excludeFields = ['searchTerm', 'sort', 'limit', 'page', 'fields'];
        excludeFields.forEach((el) => delete queryObj[el]);
        // SEGURIDAD (IDOR / forzado de estado). El cliente NO puede filtrar por
        // campos de identidad/dueño ni de estado sensible: mongoose PISA las claves
        // del `find` base con las del query string, así que sin esto un
        // `?user=<otro>` sobrescribía el scope de dueño de endpoints como
        // myBondRequests/my-audios/my-playlists → IDOR (ver otro usuario), y
        // `?moderationStatus=REJECTED` / `?isBlocked=false` / `?isPause=true`
        // forzaban estados. Estos campos SOLO los fija el service en el `find`
        // base, jamás vienen del cliente.
        //
        // CAPA 1: denylist global (sin args). CAPA 2: un endpoint puede OPT-IN a
        // campos puntuales pasando `allowedFields` (p.ej. el panel admin de audios
        // filtra por `moderationStatus`/`isBlocked`). SOLO es seguro cuando el
        // `find` base NO tiene scope de dueño (admin ve todo); en endpoints con
        // scope (my-*), NO pasar `allowedFields` para no reabrir el IDOR.
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
        // El `as string` de antes era una MENTIRA de TypeScript: Express entrega un
        // ARRAY cuando la query repite la clave (`?sort=a&sort=b`), y ahí
        // `.startsWith` tira TypeError -> 500. Verificado. Y aunque llegue string, el
        // valor iba CRUDO al `$sort`: `?sort=$x` da un FieldPath inválido (500) y
        // `?sort=-` deja el nombre VACÍO (500). `sanitizeMongo` no cubre nada de esto:
        // limpia CLAVES con `$`/`.`, no VALORES.
        // Este método lo usan 21 endpoints montados, así que el arreglo va acá y no
        // uno por uno.
        const crudo = Array.isArray(this.query.sort)
            ? this.query.sort[0]
            : this.query.sort;
        const sortField = typeof crudo === 'string' ? crudo.trim() : '';

        // Forma aceptable de un campo: uno o más segmentos separados por punto,
        // cada uno empezando por letra o guión bajo, y un '-' opcional adelante
        // para descendente. Cualquier otra cosa cae al orden por defecto en vez de
        // romper.
        // OJO con la versión ingenua `/^-?[A-Za-z_][A-Za-z0-9_.]*$/`: deja pasar
        // `a.`, `a..b` y `a.b.` —comprobado— y Mongo los rechaza igual
        // ("FieldPath must not end with a '.'", "field names may not be empty"),
        // así que el 500 volvía por la misma puerta. Exigir la ESTRUCTURA de los
        // segmentos, no sólo el conjunto de caracteres, es lo que la cierra.
        // No es una allowlist de campos reales (este builder es genérico y no
        // conoce el modelo): un campo inexistente pero bien formado simplemente no
        // ordena por nada, que es fallar cerrado.
        const esCampoValido =
            /^-?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(
                sortField
            );

        if (esCampoValido) {
            const order = sortField.startsWith('-') ? -1 : 1;
            // Anclado: el `replace('-','')` sin ancla borraba el PRIMER guión esté
            // donde esté, así que un campo con guión en el medio quedaba corrompido.
            const fieldName = sortField.replace(/^-/, '');
            this.modelQuery = this.modelQuery.sort({ [fieldName]: order });
        } else {
            // Default sorting if no valid sort option is provided
            this.modelQuery = this.modelQuery.sort('-createdAt');
        }

        return this;
    }

    paginate() {
        // Tope de seguridad: page/limit se fuerzan a enteros positivos y el limit
        // se acota a un máximo global (500). Antes se pasaba Number(limit) directo a
        // Mongo → un usuario podía pedir un limit gigante y forzar consultas/respuestas
        // costosas (DoS barato). El tope es 500 (no 100) porque hay usos legítimos que
        // piden 500 (ej. all-audios que el front filtra por tema); igual corta los
        // pedidos absurdos (miles/millones).
        const page = clampPage(this?.query.page);
        const limit = clampLimit(this?.query.limit); // tope 500 (comportamiento previo)
        const skip = (page - 1) * limit;
        this.modelQuery = this.modelQuery.skip(skip).limit(limit);
        return this;
    }
    fields() {
        // Denylist de proyeccion: se descartan del `?fields=` del cliente los
        // campos sensibles (vectores/coordenadas/secretos). Sin esto, un
        // `?fields=offerVector,location` reexponia datos que el service excluye
        // (o rompia con "proyeccion mixta"). Si tras filtrar no queda nada, se
        // conserva el default previo (`-_v`).
        // Mismo problema que en `sort()`: con `?fields=a&fields=b` Express entrega un
        // ARRAY y `.split` tira TypeError -> 500 (verificado). Se normaliza a string
        // uniendo con coma, que además preserva la intención del cliente (pidió los
        // dos campos). Lo usan 19 endpoints montados.
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
        // Mismos clamps que paginate() → la metadata (limit/totalPages) ya no puede
        // desincronizarse de la consulta real (antes usaba el limit crudo del query).
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
