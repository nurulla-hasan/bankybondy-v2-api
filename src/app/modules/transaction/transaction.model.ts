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
        // Moneda del `amount`. MercadoPago cobra en ARS (el precio se convierte
        // con la cotización del día) y PayPal en USD: sin este campo la columna
        // mezclaba las dos y cualquier suma sobre `amount` daba un número sin
        // sentido. Default 'USD' porque todo lo anterior a MercadoPago se cobró
        // en dólares, así que los registros históricos quedan bien tipados.
        currency: {
            type: String,
            enum: ['USD', 'ARS'],
            default: 'USD',
        },
        // Plan de la suscripción (Standard | Premium). Solo se completa cuando
        // type === 'Subscription'; en donaciones queda sin setear. Antes la
        // transacción NO guardaba el plan, así que el dashboard no podía separar
        // ingresos Standard vs Premium — sobre todo en MercadoPago, donde el
        // `amount` viene en ARS convertidos y no se puede inferir el plan. Con
        // este campo el desglose Income queda robusto y confiable de acá en adelante.
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
        // ¿EL EFECTO DE ESTE COBRO LLEGÓ A APLICARSE?
        //
        // La `Transaction` es el candado de idempotencia, y hasta acá sólo decía
        // "este pago ya se registró". No decía si el PLAN llegó a otorgarse, y esa
        // diferencia resuelve dos problemas que parecían separados:
        //
        // 1. **El camino `already` revertía la palanca del admin.** Ante un 11000
        //    se re-aplicaba el plan sin condición —lo cual cura una acreditación
        //    que murió a mitad— pero también deshacía una revocación humana: se
        //    revocaba un Premium por contracargo y la siguiente re-entrega de la
        //    pasarela lo devolvía, de por vida y en silencio. Con esta marca, el
        //    `already` sólo re-aplica si el efecto NUNCA llegó a aplicarse.
        //
        // 2. **"Se cobró y no se aplicó" no quedaba en ningún lado consultable.**
        //    El único rastro era un `console.error`. La palanca del dashboard
        //    existe para reparar justamente esos casos, pero no había forma de
        //    ENCONTRARLOS salvo grepear logs. Ahora es una consulta:
        //    `Transaction.find({ type: 'Subscription', applied: false })`.
        //
        // Las transacciones anteriores a este campo no lo tienen, y eso está bien:
        // `applied !== true` las trata como "no confirmado", que es exactamente lo
        // que son.
        applied: {
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
