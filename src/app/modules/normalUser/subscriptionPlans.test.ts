/* Pruebas puras de los planes y de la guarda ANTI-DOWNGRADE.
 *
 * Es el área con vara de "seguro", así que los casos que importan no son los
 * felices: son los que deciden si alguien que pagó se queda sin su plan, o si
 * alguien que no pagó se queda con uno.
 *
 * La suscripción es DE POR VIDA: un downgrade indebido no se cura solo NUNCA.
 * Por eso `tiposHastaNivelDe` —que es lo que viaja en el filtro del update— tiene
 * tantos casos como tiene. */
import {
    esTipoPlan,
    nivelDe,
    PLANES,
    planPorMontoUsd,
    tiposHastaNivelDe,
} from './subscriptionPlans';

type Case = [name: string, cond: boolean];

const mismos = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();

const cases: Case[] = [
    // ── los tres planes existen y están ordenados ───────────────────────────
    ['Free existe con nivel 0', PLANES.Free.nivel === 0],
    ['Standard existe con nivel 1', PLANES.Standard.nivel === 1],
    ['Premium existe con nivel 2', PLANES.Premium.nivel === 2],
    [
        'los niveles son estrictamente crecientes',
        PLANES.Free.nivel < PLANES.Standard.nivel &&
            PLANES.Standard.nivel < PLANES.Premium.nivel,
    ],
    [
        'el bondLimit crece con el nivel',
        PLANES.Free.bondLimit < PLANES.Standard.bondLimit &&
            PLANES.Standard.bondLimit < PLANES.Premium.bondLimit,
    ],
    ['Free no se cobra por PayPal', PLANES.Free.usdPaypal === 0],
    ['Free no se cobra por MercadoPago', PLANES.Free.usdMercadopago === 0],

    // ── esTipoPlan ──────────────────────────────────────────────────────────
    ['reconoce Standard', esTipoPlan('Standard')],
    ['rechaza un tipo inventado', !esTipoPlan('Platinum')],
    ['rechaza undefined', !esTipoPlan(undefined)],
    ['rechaza null', !esTipoPlan(null)],
    ['rechaza un objeto', !esTipoPlan({ tipo: 'Premium' })],
    // Un atacante que mande `{"$ne": null}` como planType: tiene que rebotar acá
    // y no llegar nunca a un filtro de Mongo.
    ['rechaza un operador de Mongo', !esTipoPlan({ $ne: null })],
    ['es sensible a mayúsculas (no acepta "premium")', !esTipoPlan('premium')],

    // ── nivelDe: el default importa para la guarda ──────────────────────────
    ['nivel de Premium = 2', nivelDe('Premium') === 2],
    // Lo DESCONOCIDO vale 0, no -1 ni un número alto. Con -1, cualquier pago
    // pisaría un Premium; con un número alto, un pago legítimo no se acreditaría.
    ['un tipo desconocido vale 0, no negativo', nivelDe('Platinum') === 0],
    ['undefined vale 0', nivelDe(undefined) === 0],
    ['null vale 0', nivelDe(null) === 0],
    ['un objeto vale 0', nivelDe({}) === 0],

    // ── tiposHastaNivelDe: EL CORAZÓN DE LA GUARDA ──────────────────────────
    // Es lo que va en el filtro del updateOne. Si esta lista estuviera mal, o se
    // bloquearían pagos legítimos o se permitirían downgrades.
    [
        'acreditar Free sólo aplica sobre Free',
        mismos(tiposHastaNivelDe('Free'), ['Free']),
    ],
    [
        'acreditar Standard aplica sobre Free y Standard',
        mismos(tiposHastaNivelDe('Standard'), ['Free', 'Standard']),
    ],
    [
        'acreditar Premium aplica sobre los tres',
        mismos(tiposHastaNivelDe('Premium'), ['Free', 'Standard', 'Premium']),
    ],
    // EL CASO QUE MOTIVA TODO: un webhook viejo de Standard reintentado sobre
    // alguien que YA es Premium. Premium NO puede estar en la lista, o el
    // filtro matchearía y le bajaría el plano para siempre.
    [
        'un pago Standard NO puede pisar un Premium',
        !tiposHastaNivelDe('Standard').includes('Premium' as never),
    ],
    [
        'un pago Free NO puede pisar un Standard',
        !tiposHastaNivelDe('Free').includes('Standard' as never),
    ],
    // Re-acreditar el MISMO plan sí tiene que funcionar: es el camino `already`,
    // que re-aplica el efecto para curar una acreditación que murió a mitad.
    [
        'reacreditar el mismo plan SÍ aplica (camino already)',
        tiposHastaNivelDe('Premium').includes('Premium' as never) &&
            tiposHastaNivelDe('Standard').includes('Standard' as never),
    ],

    // ── planPorMontoUsd: la vía de PayPal acredita POR MONTO ────────────────
    [
        'el monto de Standard devuelve Standard',
        planPorMontoUsd(PLANES.Standard.usdPaypal)?.tipo === 'Standard',
    ],
    [
        'el monto de Premium devuelve Premium',
        planPorMontoUsd(PLANES.Premium.usdPaypal)?.tipo === 'Premium',
    ],
    // Manipulación del importe: nada que no sea exactamente un precio acredita.
    ['un monto de 1 no acredita nada', planPorMontoUsd(1) === null],
    ['un monto de 0 no acredita nada', planPorMontoUsd(0) === null],
    ['un monto negativo no acredita nada', planPorMontoUsd(-25) === null],
    ['un monto basura no acredita nada', planPorMontoUsd('veinticinco') === null],
    ['NaN no acredita nada', planPorMontoUsd(NaN) === null],
    ['Infinity no acredita nada', planPorMontoUsd(Infinity) === null],
    // 0 es el `usdPaypal` de Free. Si el filtro `usdPaypal > 0` no estuviera,
    // un pago de CERO dólares devolvería el plan Free y lo "acreditaría".
    ['el 0 no matchea el plan Free', planPorMontoUsd(0)?.tipo !== 'Free'],
    [
        'un string numérico igual al precio SÍ acredita (PayPal manda strings)',
        planPorMontoUsd(String(PLANES.Premium.usdPaypal))?.tipo === 'Premium',
    ],
];

export const runSubscriptionPlanTests = (): { pass: number; fail: number } => {
    let pass = 0,
        fail = 0;
    for (const [name, cond] of cases) {
        if (cond) pass++;
        else {
            fail++;
            // eslint-disable-next-line no-console
            console.error('FAIL:', name);
        }
    }
    return { pass, fail };
};
