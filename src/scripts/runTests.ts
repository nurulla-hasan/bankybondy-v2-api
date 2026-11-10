/* Runs the project's pure test suites (no DB, no network) and exits 1 on failure,
 * so it can be chained in scripts. No vitest/jest on purpose: no new dependency. */
import { runMatchingScoreTests } from '../app/modules/bondRequest/matching.scoring.test';
import { runPublicShapeTests } from '../app/modules/bondRequest/bondRequest.publicShape.test';
import { runAttachmentUrlTests } from '../app/helper/attachmentUrl.test';
import { runMessagePipelineTests } from '../app/modules/message/message.pipeline.test';
import { runScrubDeletedPreviewTests } from '../app/helper/scrubDeletedPreview.test';
import { runNormalizeMessageTextTests } from '../app/helper/normalizeMessageText.test';
import { runMarkSeenTests } from '../app/helper/markSeen.test';
import { runMessageRejectionTests } from '../app/helper/messageRejection.test';
import { runSocketTokenTests } from '../app/helper/socketToken.test';
import { runMessageEmitShapeTests } from '../app/helper/messageEmitShape.test';
import { runEmitConversationSnapshotsTests } from '../app/helper/emitConversationSnapshots.test';
import { runChatGroupRosterTests } from '../app/modules/chatGroup/chatGroup.roster.test';
import { runMediaPipelineTests } from '../app/modules/conversation/media.pipeline.test';
import { runPaginationTests } from '../app/utilities/pagination.test';
import { runObjectIdTests } from '../app/utilities/objectId.test';
import { runSessionCodesTests } from '../app/utilities/sessionCodes.test';
import { runQueryBuilderTests } from '../app/builder/QueryBuilder.test';
import { runInputValidationTests } from '../app/modules/bondRequest/inputValidation.test';
import { runMatchingScheduleTests } from '../app/modules/bondRequest/matching.schedule.test';
import { runMatchingFeedTests } from '../app/modules/bondRequest/matching.feed.test';
import { runSubscriptionPlanTests } from '../app/modules/normalUser/subscriptionPlans.test';
import { runSubscriptionCheckoutTests } from '../app/modules/normalUser/subscriptionCheckout.test';
import { runAudioModerationTests } from '../app/modules/audio/audio.moderation.test';
import { runImageModerationTests } from '../app/helper/moderateImage.test';
import { runAudioListenTests } from '../app/modules/audio/audio.listen.test';
import { runTrendingTests } from '../app/modules/audio/audio.trending.test';
import { runBondIdentityTests } from '../app/modules/bondRequest/bondIdentity.test';
import { runBondLinkLifecycleTests } from '../app/modules/bondLink/bondLink.lifecycle.test';
import { runBondMaintenanceTests } from '../app/modules/bondRequest/bondMaintenance.test';
import { runBondMaintenanceExecutionTests } from '../app/modules/bondRequest/bondMaintenance.execution.test';
import { runBondReconciliationTests, runBondReconciliationExecutionTests } from '../app/modules/bondRequest/bondMaintenance.reconcile.test';

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
        {
            nombre: 'matching.feed (read model por participante)',
            correr: runMatchingFeedTests,
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
            nombre: 'socketToken (claims del handshake B0)',
            correr: runSocketTokenTests,
        },
        {
            nombre: 'messageEmitShape (forma del mensaje recién enviado B1)',
            correr: runMessageEmitShapeTests,
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
        { nombre: 'bond identity and response contracts', correr: runBondIdentityTests },
        { nombre: 'bond terminal lifecycle', correr: runBondLinkLifecycleTests },
        { nombre: 'bond maintenance projection', correr: runBondMaintenanceTests },
        { nombre: 'bond maintenance execution', correr: runBondMaintenanceExecutionTests },
        { nombre: 'bond reconciliation', correr: runBondReconciliationTests },
        { nombre: 'bond reconciliation execution', correr: runBondReconciliationExecutionTests },
        {
            nombre: 'subscriptionPlans (anti-downgrade / pagos)',
            correr: runSubscriptionPlanTests,
        },
        {
            nombre: 'subscriptionCheckout (reuso / reclamo de checkout)',
            correr: runSubscriptionCheckoutTests,
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
