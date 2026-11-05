import { Router } from 'express';
import { AdminRoutes } from '../modules/admin/admin.routes';
import { audioRoutes } from '../modules/audio/audio.routes';
import { audioBookmarkRoutes } from '../modules/audioBookmark/audio.bookmark.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { bannerRoutes } from '../modules/banner/banner.routes';
import { bondRoutes } from '../modules/bond/bond.routes';
import { bondLinkRoutes } from '../modules/bondLink/bondLink.routes';
import { bondRatingRoutes } from '../modules/bondRating/bondRating.routes';
import { bondRequestRoutes } from '../modules/bondRequest/bondRequest.routes';
import { categoryRoutes } from '../modules/category/category.routes';
import { chatGroupRoutes } from '../modules/chatGroup/chatGroup.routes';
// PARKEADO (instituciones apagadas): el módulo `comment` opera 100% sobre
// `institutionConversation` (schema lo EXIGE). Desmontado como el resto de
// institution*/project*; código intacto, reactivar = descomentar. Ver más abajo.
// import { commentRoutes } from '../modules/comment/comment.routes';
import { consumidorRoutes } from '../modules/consumidor/consumidor.routes';
import { conversationRoutes } from '../modules/conversation/conversation.routes';
import { DonateRoutes } from '../modules/donate/donate.routes';
import { feedbackRoutes } from '../modules/feedback/feedback.routes';
import { fileUploadRoutes } from '../modules/file/file.routes';
import { friendRequestRoutes } from '../modules/friendRequest/friendRequest.routes';
// PARKEADO (objetos/instituciones/proyectos apagados: NADA debe funcionar). Los
// módulos quedan INTACTOS en el repo; solo se desmontan del router. Reactivar =
// descomentar estos imports y sus mounts abajo ("solo cablear").
// import { institutionRoutes } from '../modules/institution/institution.routes';
// import { institutionConversationRoutes } from '../modules/institutionConversation/institutionConversation.routes';
// import { institutionMemberRoutes } from '../modules/institutionMember/institutionMember.routes';
import { ManageRoutes } from '../modules/manage-web/manage.routes';
import { messageRoutes } from '../modules/message/message.routes';
import { metaRoutes } from '../modules/meta/meta.routes';
import { normalUserRoutes } from '../modules/normalUser/normalUser.routes';
import { notificationRoutes } from '../modules/notification/notification.routes';
import { playlistRoutes } from '../modules/playlist/playlist.routes';
// PARKEADO (ver nota arriba): módulos de proyecto desmontados, código intacto.
// import { projectRoutes } from '../modules/project/project.routes';
// import { projectDocumentRoutes } from '../modules/projectDocument/projectDocument.routes';
// import { projectImageRoutes } from '../modules/projectImage/projectImage.routes';
// import { projectJoinRequestRoutes } from '../modules/projectJoinRequest/projectJoinRequest.routes';
// import { projectMemberRoutes } from '../modules/projectMember/projectMember.routes';
import { recommendedUserRoutes } from '../modules/recommendedUser/recommendedUser.routes';
import { reportRoutes } from '../modules/report/report.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { skillRoutes } from '../modules/skill/skill.routes';
import { superAdminRoutes } from '../modules/superAdmin/superAdmin.routes';
import { topicRoutes } from '../modules/topic/topic.routes';
import { transactionRoutes } from '../modules/transaction/transaction.routes';
import { userRoutes } from '../modules/user/user.routes';
import { userBlockRoutes } from '../modules/userBlock/userBlock.routes';

const router = Router();

const moduleRoutes = [
    {
        path: '/auth',
        router: authRoutes,
    },
    {
        path: '/user',
        router: userRoutes,
    },
    {
        path: '/normal-user',
        router: normalUserRoutes,
    },
    {
        path: '/admin',
        router: AdminRoutes,
    },
    {
        path: '/manage',
        router: ManageRoutes,
    },
    {
        path: '/notification',
        router: notificationRoutes,
    },
    {
        path: '/category',
        router: categoryRoutes,
    },

    {
        path: '/banner',
        router: bannerRoutes,
    },
    {
        path: '/meta',
        router: metaRoutes,
    },
    {
        path: '/feedback',
        router: feedbackRoutes,
    },

    {
        path: '/transaction',
        router: transactionRoutes,
    },

    {
        path: '/topic',
        router: topicRoutes,
    },
    {
        path: '/report',
        router: reportRoutes,
    },
    {
        path: '/skill',
        router: skillRoutes,
    },
    // PARKEADO: {
    //     path: '/project',
    //     router: projectRoutes,
    // },
    {
        path: '/audio',
        router: audioRoutes,
    },
    {
        path: '/audio-bookmark',
        router: audioBookmarkRoutes,
    },
    {
        path: '/playlist',
        router: playlistRoutes,
    },
    // PARKEADO (objetos/instituciones/proyectos apagados): bloque desmontado.
    // {
    //     path: '/project-join-request',
    //     router: projectJoinRequestRoutes,
    // },
    // {
    //     path: '/project-member',
    //     router: projectMemberRoutes,
    // },
    // {
    //     path: '/project-document',
    //     router: projectDocumentRoutes,
    // },
    // {
    //     path: '/project-image',
    //     router: projectImageRoutes,
    // },
    // {
    //     path: '/institution',
    //     router: institutionRoutes,
    // },
    // {
    //     path: '/institution-member',
    //     router: institutionMemberRoutes,
    // },
    // {
    //     path: '/institution-conversation',
    //     router: institutionConversationRoutes,
    // },
    // PARKEADO (instituciones apagadas): `/comment` opera sobre institutionConversation.
    // {
    //     path: '/comment',
    //     router: commentRoutes,
    // },
    {
        path: '/bond',
        router: bondRoutes,
    },
    {
        path: '/bond-request',
        router: bondRequestRoutes,
    },
    {
        path: '/friend-request',
        router: friendRequestRoutes,
    },
    {
        path: '/bond-link',
        router: bondLinkRoutes,
    },
    {
        path: '/donate',
        router: DonateRoutes,
    },
    {
        // Botón de arrepentimiento y de baja (Disp. 954/2025). Público.
        path: '/consumidor',
        router: consumidorRoutes,
    },
    {
        path: '/chat-group',
        router: chatGroupRoutes,
    },
    {
        path: '/conversation',
        router: conversationRoutes,
    },
    {
        path: '/message',
        router: messageRoutes,
    },
    {
        path: '/file-upload',
        router: fileUploadRoutes,
    },
    {
        path: '/super-admin',
        router: superAdminRoutes,
    },
    {
        path: '/bond-rating',
        router: bondRatingRoutes,
    },
    {
        path: '/recommended-user',
        router: recommendedUserRoutes,
    },
    {
        path: '/user-block',
        router: userBlockRoutes,
    },
    {
        path: '/search',
        router: searchRoutes,
    },
];

moduleRoutes.forEach((route) => router.use(route.path, route.router));

export default router;
