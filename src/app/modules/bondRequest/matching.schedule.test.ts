/* Pruebas puras de la AGENDA del recómputo (matching.schedule).
 *
 * Blindan la política que separa 800 usuarios de decenas de miles. Los casos
 * peligrosos NO son los felices: son los datos rotos (fecha inválida, campos
 * ausentes, reloj torcido) donde una temperatura mal calculada degrada en
 * silencio — o vuelve a poner al sweep en recómputo continuo, que ya frenó la API
 * una vez. */
import {
    AGENDA,
    proximoRecomputoEn,
    temperaturaDe,
    ttlMinutosDe,
} from './matching.schedule';

type Case = [name: string, cond: boolean];

const AHORA = Date.parse('2026-09-11T12:00:00.000Z');
const horasAtras = (h: number) => new Date(AHORA - h * 3600_000);

// Diales fijos para que los tests no dependan del entorno: si alguien exporta
// MATCH_TTL_HOT_MINUTES en su shell, estas aserciones tienen que seguir valiendo.
const D = {
    ventanaCalienteHoras: 72,
    ventanaTibiaHoras: 24 * 14,
    ttlCalienteMin: 60,
    ttlTibioMin: 360,
    ttlFrioMin: 1440,
};

const cases: Case[] = [
    // ── temperatura por creación ────────────────────────────────────────────
    [
        'recién creado → caliente',
        temperaturaDe({ ahora: AHORA, createdAt: horasAtras(1) }, D) ===
            'caliente',
    ],
    [
        'creado hace 71 h → caliente',
        temperaturaDe({ ahora: AHORA, createdAt: horasAtras(71) }, D) ===
            'caliente',
    ],
    [
        'creado hace 73 h → tibio',
        temperaturaDe({ ahora: AHORA, createdAt: horasAtras(73) }, D) ===
            'tibio',
    ],
    [
        'creado hace 20 días → frío',
        temperaturaDe({ ahora: AHORA, createdAt: horasAtras(24 * 20) }, D) ===
            'frio',
    ],
    // El BORDE exacto cuenta como el nivel MÁS caliente (<=, no <). Sin esto, un
    // vínculo justo en el límite oscilaría entre dos TTL según el microsegundo.
    [
        'borde exacto de 72 h → caliente (<=, no <)',
        temperaturaDe({ ahora: AHORA, createdAt: horasAtras(72) }, D) ===
            'caliente',
    ],
    [
        'borde exacto de 14 días → tibio',
        temperaturaDe({ ahora: AHORA, createdAt: horasAtras(24 * 14) }, D) ===
            'tibio',
    ],

    // ── la señal de interés real: lastServedAt ───────────────────────────────
    // El caso que justifica todo el diseño: un vínculo VIEJO que alguien acaba de
    // mirar tiene que volver a estar caliente. Si esto fallara, abrir la pantalla
    // de coincidencias de un vínculo de hace un año lo dejaría refrescándose cada
    // 24 h y el usuario vería datos rancios sin entender por qué.
    [
        'vínculo viejo pero recién MIRADO → caliente',
        temperaturaDe(
            {
                ahora: AHORA,
                createdAt: horasAtras(24 * 365),
                lastServedAt: horasAtras(2),
            },
            D
        ) === 'caliente',
    ],
    [
        'vínculo nuevo nunca mirado → caliente igual (createdAt manda)',
        temperaturaDe(
            { ahora: AHORA, createdAt: horasAtras(2), lastServedAt: null },
            D
        ) === 'caliente',
    ],
    [
        'viejo y mirado hace mucho → frío',
        temperaturaDe(
            {
                ahora: AHORA,
                createdAt: horasAtras(24 * 100),
                lastServedAt: horasAtras(24 * 90),
            },
            D
        ) === 'frio',
    ],
    [
        'se toma la señal MÁS RECIENTE, no la primera',
        temperaturaDe(
            {
                ahora: AHORA,
                createdAt: horasAtras(24 * 100),
                lastServedAt: horasAtras(100),
            },
            D
        ) === 'tibio',
    ],

    // ── datos rotos (el caso peligroso de verdad) ────────────────────────────
    // `new Date(undefined).getTime()` es NaN. Si NaN se filtrara, toda
    // comparación daría false y el vínculo caería en 'frio' por accidente en vez
    // de por política — o peor, `proximoRecomputoEn` devolvería Invalid Date y el
    // sweep nunca volvería a tomarlo.
    [
        'sin ninguna fecha → frío (sin romper)',
        temperaturaDe({ ahora: AHORA }, D) === 'frio',
    ],
    [
        'createdAt basura → frío (sin romper)',
        temperaturaDe({ ahora: AHORA, createdAt: 'no-es-fecha' }, D) === 'frio',
    ],
    [
        'createdAt basura pero servido recién → caliente (la señal buena gana)',
        temperaturaDe(
            {
                ahora: AHORA,
                createdAt: 'no-es-fecha',
                lastServedAt: horasAtras(1),
            },
            D
        ) === 'caliente',
    ],
    [
        'fechas rotas NO producen Invalid Date en la agenda',
        Number.isFinite(
            proximoRecomputoEn(
                { ahora: AHORA, createdAt: 'no-es-fecha' },
                D
            ).getTime()
        ),
    ],
    // Reloj torcido / dato sembrado en el futuro: antigüedad negativa. Cuenta
    // como caliente (se refresca de más, no de menos). Es el lado seguro.
    [
        'fecha en el FUTURO → caliente, no frío',
        temperaturaDe({ ahora: AHORA, createdAt: horasAtras(-50) }, D) ===
            'caliente',
    ],

    // ── TTL por nivel ───────────────────────────────────────────────────────
    ['ttl caliente = 60 min', ttlMinutosDe('caliente', D) === 60],
    ['ttl tibio = 360 min', ttlMinutosDe('tibio', D) === 360],
    ['ttl frío = 1440 min', ttlMinutosDe('frio', D) === 1440],
    [
        'el TTL crece estrictamente con el frío',
        ttlMinutosDe('caliente', D) < ttlMinutosDe('tibio', D) &&
            ttlMinutosDe('tibio', D) < ttlMinutosDe('frio', D),
    ],

    // ── la agenda ───────────────────────────────────────────────────────────
    [
        'agenda de un caliente = ahora + 60 min',
        proximoRecomputoEn(
            { ahora: AHORA, createdAt: horasAtras(1) },
            D
        ).getTime() ===
            AHORA + 60 * 60_000,
    ],
    [
        'agenda de un frío = ahora + 24 h',
        proximoRecomputoEn(
            { ahora: AHORA, createdAt: horasAtras(24 * 60) },
            D
        ).getTime() ===
            AHORA + 1440 * 60_000,
    ],
    [
        'la agenda SIEMPRE cae en el futuro',
        proximoRecomputoEn({ ahora: AHORA }, D).getTime() > AHORA,
    ],

    // ── los diales reales (los que van a producción) ─────────────────────────
    // Un TTL de 0 volvería a poner el sweep en recómputo continuo: el "cómputo
    // desbocado" que ya frenó la API. El clamp tiene que hacerlo imposible aunque
    // alguien exporte MATCH_TTL_HOT_MINUTES=0.
    [
        'ningún TTL real puede ser 0',
        AGENDA.ttlCalienteMin >= 5 &&
            AGENDA.ttlTibioMin >= 5 &&
            AGENDA.ttlFrioMin >= 5,
    ],
    // El código FUERZA el orden de las ventanas (Math.max), no lo asume: una
    // ventana tibia menor que la caliente volvería 'tibio' inalcanzable en
    // silencio. Esto vale con cualquier env, que es el punto.
    [
        'el código fuerza caliente ⊆ tibio',
        AGENDA.ventanaCalienteHoras <= AGENDA.ventanaTibiaHoras,
    ],
    [
        'con ventanas invertidas a mano, tibio queda vacío pero nada rompe',
        temperaturaDe(
            { ahora: AHORA, createdAt: horasAtras(100) },
            { ...D, ventanaCalienteHoras: 200, ventanaTibiaHoras: 10 }
        ) === 'caliente',
    ],
];

export const runMatchingScheduleTests = (): { pass: number; fail: number } => {
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
