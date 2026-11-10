import { model, Schema } from 'mongoose';
import { MATCHING } from '../bondRequest/matching.config';
import { ENUM_GENDER } from '../user/user.enum';
import { ENUM_SUBSCRIPTION_TYPE } from './normalUser.enum';
import { INormalUser } from './normalUser.interface';

const NormalUserSchema = new Schema<INormalUser>(
    {
        user: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: 'User',
        },
        // username: {
        //     type: String,
        //     required: true,
        // },
        name: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
        },
        phone: {
            type: String,
        },
        profile_image: {
            type: String,
            default: '',
        },
        cover_image: {
            type: String,
            default: '',
        },
        gender: {
            type: String,
            enum: Object.values(ENUM_GENDER),
        },
        dateOfBirth: {
            type: Date,
        },
        address: {
            type: String,
        },
        bio: {
            type: String,
        },
        skills: [
            {
                type: Schema.Types.ObjectId,
                ref: 'Skill',
            },
        ],
        socialLinks: {
            type: [String],
            default: [],
        },
        subscriptionType: {
            type: String,
            enum: Object.values(ENUM_SUBSCRIPTION_TYPE),
            default: ENUM_SUBSCRIPTION_TYPE.Free,
        },
        bondLimit: {
            type: Number,
            default: 25,
        },
        // MANUAL ADMIN LEVER TRAIL. Subscription is lifetime, so the only way a
        // plan can go DOWN is an admin deciding it (chargeback), and the only way
        // it can go up without payment is an admin repair. Both move money, so
        // they must leave a record.
        //
        // IT IS A HISTORY, NOT A SLOT: appending with `$push` + `$slice` keeps
        // earlier changes (a `$set` erased the chargeback entry a dispute needs).
        subscriptionHistory: {
            type: [
                {
                    _id: false,
                    type: { type: String },
                    by: { type: Schema.Types.ObjectId, ref: 'User' },
                    at: { type: Date },
                    reason: { type: String },
                    // The plan BEFORE. Without it a single row cannot tell a
                    // downgrade from an upgrade.
                    from: { type: String },
                },
            ],
            default: [],
        },
        // Denormalized from the last history entry, so listing/filtering works
        // without opening the array.
        subscriptionSetBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
        },
        subscriptionSetAt: { type: Date },
        subscriptionSetReason: { type: String },
        // Last cap already notified for the subscription nudge (once per cap).
        // See the SUBSCRIPTION notification in bondRequest.service.
        subscriptionNudgeAt: {
            type: Number,
            default: 0,
        },
        // Checkout started but not yet paid. Its URL is reused while fresh (see
        // subscriptionCheckout.ts) so two tabs do not create two payable orders
        // for the same plan. `url: ''` = claim in progress.
        pendingSubscriptionCheckout: {
            plan: {
                type: String,
                enum: [
                    ENUM_SUBSCRIPTION_TYPE.Standard,
                    ENUM_SUBSCRIPTION_TYPE.Premium,
                ],
            },
            provider: {
                type: String,
                enum: ['paypal', 'mercadopago'],
            },
            // No `default`: it would make EVERY new doc be born with
            // `pendingSubscriptionCheckout: { url: '' }`, as if a checkout were
            // in progress.
            url: {
                type: String,
            },
            createdAt: {
                type: Date,
            },
        },
        // Internal guard counter to serialize concurrent bond creations (bondLimit
        // race fix). Only incremented inside the creation transaction; its value
        // has no business meaning.
        bondSeq: {
            type: Number,
            default: 0,
        },
        // Privacy: if false, others do not see the bond list on the profile (only
        // the count). The owner always sees their own.
        bondsPublic: {
            type: Boolean,
            default: true,
        },
        // Privacy: if false, the profile is hidden from the People listing and its
        // search. Does NOT affect matching (bonds still enter chains) nor direct
        // link access (/people/:id keeps working).
        listedInPeople: {
            type: Boolean,
            default: true,
        },
        // "Has at least one live bond": primary People sort key in Featured.
        // Written only by bond creation (in its transaction) and vinculosVivos.ts.
        // Internal: in PRIVATE_USER_FIELDS, never returned.
        hasActiveBonds: {
            type: Boolean,
            default: false,
        },
        // Per-CATEGORY notification mute. Categories are still created, they just
        // do not add to the badge.
        mutedNotificationCategories: {
            type: [String],
            default: [],
        },
        // Weekly digest opt-out (List-Unsubscribe). true = no automatic digest.
        // Transactional mail is unaffected. Default false (subscribed).
        digestOptOut: {
            type: Boolean,
            default: false,
        },
        // Cached reputation (recomputed on each BondRating).
        reputation: {
            avg: { type: Number, default: 0 },
            count: { type: Number, default: 0 },
            // neutral / cold-start, aligned with REP_PRIOR in the matching config.
            score: { type: Number, default: MATCHING.reputation.prior },
        },
        // Geolocation (GeoJSON Point [lng, lat]). Optional. Used by the "near" mode
        // of the People listing and to inherit a location when creating a bond
        // without coordinates. NEVER exposed to the client.
        location: {
            type: {
                type: String,
                enum: ['Point'],
            },
            // `default: undefined` stops Mongoose from materializing coordinates: []
            // on every insert, so `location` is OMITTED without a location and the
            // sparse 2dsphere index does not break new user inserts (register /
            // Google login).
            coordinates: {
                type: [Number],
                default: undefined,
            },
        },
        locationUpdatedAt: {
            type: Date,
        },
        locationMode: {
            type: String,
            enum: ['auto', 'manual'],
        },
    },
    {
        timestamps: true,
    }
);
// Geospatial index for $near / $geoWithin queries on location.
NormalUserSchema.index({ location: '2dsphere' });
// Supports the sort=reputation filter (orders by reputation.score desc).
NormalUserSchema.index({ 'reputation.score': -1 });
// Featured (People's default mode): SAME order as the screen, field by field, so
// pages come from walking the index instead of an in-memory sort of all users.
// Page p reads ~15·p users: the `$skip` is walked too.
NormalUserSchema.index(
    { hasActiveBonds: -1, 'reputation.score': -1, updatedAt: -1, _id: 1 },
    { name: 'personas_destacados' }
);
const NormalUser = model<INormalUser>('NormalUser', NormalUserSchema);

export default NormalUser;
