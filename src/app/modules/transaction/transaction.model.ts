import { Schema, model, Types } from 'mongoose';
import { ENUM_TRANSACTION_TYPE } from '../../utilities/enum';
import { ENUM_SUBSCRIPTION_TYPE } from '../normalUser/normalUser.enum';

const TransactionSchema = new Schema(
    {
        user: {
            type: Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        type: {
            type: String,
            enum: Object.values(ENUM_TRANSACTION_TYPE),
            required: true,
        },
        amount: {
            type: Number,
            required: true,
            min: 0,
        },
        // Currency of `amount`. MercadoPago charges in ARS (price converted at the
        // day's rate) and PayPal in USD: without this, the column mixed both and
        // any sum over `amount` was meaningless. Default 'USD' because everything
        // before MercadoPago was charged in dollars, so history stays well-typed.
        currency: {
            type: String,
            enum: ['USD', 'ARS'],
            default: 'USD',
        },
        // Plan of the subscription (Standard | Premium). Only set when
        // type === 'Subscription'. Without it the dashboard could not separate
        // Standard vs Premium income, especially in MercadoPago where `amount` is
        // converted ARS and the plan cannot be inferred.
        plan: {
            type: String,
            enum: [
                ENUM_SUBSCRIPTION_TYPE.Standard,
                ENUM_SUBSCRIPTION_TYPE.Premium,
            ],
        },
        transactionId: {
            type: String,
            unique: true,
            sparse: true,
        },
        // DID THIS CHARGE'S EFFECT ACTUALLY APPLY?
        //
        // `Transaction` is the idempotency lock but only said "this payment was
        // recorded", not whether the PLAN was granted. That difference fixes two
        // things: the `already` path re-applied the plan on a 11000 (curing a
        // half-applied grant but also undoing a human revocation, e.g. a
        // chargeback refund); now it re-applies only if the effect NEVER applied.
        // And "charged but not applied" is queryable:
        // `Transaction.find({ type: 'Subscription', applied: false })`.
        //
        // Older transactions lack this field, which is fine: `applied !== true`
        // treats them as "unconfirmed", exactly what they are.
        applied: {
            type: Boolean,
            default: false,
        },
        // Charged but the plan could NOT be applied (already had an equal/greater
        // one, or it came from an old checkout). Distinguishes this from "the
        // grant died mid-way": without it a gateway retry entered the `already`
        // path and re-applied the plan, dropping the payment from the refund list.
        // `Transaction.find({ type:'Subscription', refundPending:true })` is the
        // list of money to refund manually.
        refundPending: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

const Transaction = model('Transaction', TransactionSchema);

export default Transaction;
