/* Corre las pruebas puras del proyecto (sin base de datos ni red).
 *
 * Existe porque `matching.scoring.test.ts` tenía ~40 aserciones sobre el corazón
 * del matcheo pero NADIE las ejecutaba: el `npm test` del package.json era
 * `echo "Error: no test specified" && exit 1`, y el archivo sólo EXPORTA una
 * función (no se auto-ejecuta al importarlo). Estaban escritas y desconectadas.
 *
 * No usa vitest/jest a propósito: no hace falta agregar una dependencia para
 * correr funciones puras, y así el script viaja en el mismo .tgz que el resto
 * del código (package.json no viaja en los paquetes de deploy).
 *
 * Uso, ya compilado:
 *   node dist/scripts/runTests.js
 * Sale con código 1 si algo falla, así que sirve para encadenar en un script.
 */
import { runMatchingScoreTests } from '../app/modules/bondRequest/matching.scoring.test';
import { runPublicShapeTests } from '../app/modules/bondRequest/bondRequest.publicShape.test';
import { runAttachmentUrlTests } from '../app/helper/attachmentUrl.test';
import { runMessagePipelineTests } from '../app/modules/message/message.pipeline.test';
import { runScrubDeletedPreviewTests } from '../app/helper/scrubDeletedPreview.test';
import { runNormalizeMessageTextTests } from '../app/helper/normalizeMessageText.test';
import { runMarkSeenTests } from '../app/helper/markSeen.test';
import { runMessageRejectionTests } from '../app/helper/messageRejection.test';
import { runEmitConversationSnapshotsTests } from '../app/helper/emitConversationSnapshots.test';
import { runChatGroupRosterTests } from '../app/modules/chatGroup/chatGroup.roster.test';
import { runMediaPipelineTests } from '../app/modules/conversation/media.pipeline.test';
import { runPaginationTests } from '../app/utilities/pagination.test';
import { runObjectIdTests } from '../app/utilities/objectId.test';
import { runSessionCodesTests } from '../app/utilities/sessionCodes.test';
import { runQueryBuilderTests } from '../app/builder/QueryBuilder.test';
import { runInputValidationTests } from '../app/modules/bondRequest/inputValidation.test';
import { runMatchingScheduleTests } from '../app/modules/bondRequest/matching.schedule.test';
import { runSubscriptionPlanTests } from '../app/modules/normalUser/subscriptionPlans.test';
import { runAudioModerationTests } from '../app/modules/audio/audio.moderation.test';
import { runImageModerationTests } from '../app/helper/moderateImage.test';
import { runAudioListenTests } from '../app/modules/audio/audio.listen.test';
import { runTrendingTests } from '../app/modules/audio/audio.trending.test';

/* eslint-disable no-console */

const main = async (): Promise<void> => {
    let pass = 0;
    let fail = 0;

    const suites: {
        nombre: string;
        correr: () => { pass: number; fail: number } | Promise<{ pass: number; fail: number }>;
    }[] = [
        { nombre: 'matching.scoring', correr: runMatchingScoreTests },
        {
            nombre: 'matching.schedule (TTL adaptativo / escala)',
            correr: runMatchingScheduleTests,
        },
        { nombre: 'bondRequest.publicShape', correr: runPublicShapeTests },
        { nombre: 'attachmentUrl', correr: runAttachmentUrlTests },
        {
            nombre: 'message.pipeline (seen / borrados / paginación)',
            correr: runMessagePipelineTests,
        },
        {
            nombre: 'scrubDeletedPreview (vista previa de chats)',
            correr: runScrubDeletedPreviewTests,
        },
        {
            nombre: 'normalizeMessageText (texto siempre string)',
            correr: runNormalizeMessageTextTests,
        },
        { nombre: 'markSeen (guardas y write)', correr: runMarkSeenTests },
        {
            nombre: 'messageRejection (los dos rechazos del envio)',
            correr: runMessageRejectionTests,
        },
        {
            nombre: 'emitConversationSnapshots (tipo → campo poblado)',
            correr: runEmitConversationSnapshotsTests,
        },
        { nombre: 'chatGroup roster (quién es miembro)', correr: runChatGroupRosterTests },
        {
            nombre: 'media.pipeline (galería: tipos y referencia)',
            correr: runMediaPipelineTests,
        },
        { nombre: 'pagination', correr: runPaginationTests },
        { nombre: 'objectId (guarda de autorizacion)', correr: runObjectIdTests },
        { nombre: 'sessionCodes (deslogueo)', correr: runSessionCodesTests },
        { nombre: 'QueryBuilder (sort/fields/paginate)', correr: runQueryBuilderTests },
        { nombre: 'inputValidation', correr: runInputValidationTests },
        {
            nombre: 'subscriptionPlans (anti-downgrade / pagos)',
            correr: runSubscriptionPlanTests,
        },
        { nombre: 'audio.moderation', correr: runAudioModerationTests },
        { nombre: 'moderateImage', correr: runImageModerationTests },
        { nombre: 'audio.listen', correr: runAudioListenTests },
        { nombre: 'audio.trending', correr: runTrendingTests },
    ];

    for (const s of suites) {
        const r = await s.correr();
        pass += r.pass;
        fail += r.fail;
        console.log(
            `  ${r.fail === 0 ? 'OK  ' : 'FALLA'} ${s.nombre}: ${r.pass} pasaron, ${r.fail} fallaron`
        );
    }

    console.log('');
    console.log(`TOTAL: ${pass} pasaron, ${fail} fallaron`);
    if (fail > 0) process.exit(1);
};

void main();
