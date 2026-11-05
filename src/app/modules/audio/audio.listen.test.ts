/* Pruebas puras de la semántica de escucha calificada (Etapa 0). Blindan el
 * umbral (≥30s o ≥40%) y la clave de dedupe diario. */
import {
    isQualifiedListen,
    dayBucketFor,
    LISTEN_MIN_SECONDS,
    LISTEN_MIN_COMPLETION,
} from './audio.listen';

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // Umbral por SEGUNDOS
    ['30s exactos → cuenta', isQualifiedListen({ secondsListened: 30 }) === true],
    ['29s sin completion → NO cuenta', isQualifiedListen({ secondsListened: 29 }) === false],
    ['45s con completion baja → cuenta (por segundos)',
        isQualifiedListen({ secondsListened: 45, completion: 0.1 }) === true],
    // Umbral por COMPLETION
    ['40% exacto → cuenta', isQualifiedListen({ completion: 0.4 }) === true],
    ['39% con pocos segundos → NO cuenta',
        isQualifiedListen({ completion: 0.39, secondsListened: 5 }) === false],
    ['audio corto escuchado entero (10s, 80%) → cuenta (por completion)',
        isQualifiedListen({ secondsListened: 10, completion: 0.8 }) === true],
    // Basura / bordes
    ['sin datos → NO cuenta', isQualifiedListen({}) === false],
    ['no-numérico → NO cuenta',
        isQualifiedListen({ secondsListened: 'x' as any, completion: null as any }) === false],
    ['negativos → NO cuenta', isQualifiedListen({ secondsListened: -100, completion: -1 }) === false],
    ['completion > 1 (basura) NO cuenta por completion sola',
        isQualifiedListen({ completion: 1.5 }) === false],
    ['completion basura pero segundos válidos → cuenta (por segundos)',
        isQualifiedListen({ completion: 99, secondsListened: 40 }) === true],
    ['constantes esperadas', LISTEN_MIN_SECONDS === 30 && LISTEN_MIN_COMPLETION === 0.4],
    // dayBucket
    ['dayBucketFor → YYYY-MM-DD (UTC)',
        dayBucketFor(new Date('2026-08-12T22:30:00.000Z')) === '2026-08-12'],
    ['dayBucketFor otro día', dayBucketFor(new Date('2026-01-01T00:00:00.000Z')) === '2026-01-01'],
];

export const runAudioListenTests = (): { pass: number; fail: number } => {
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
