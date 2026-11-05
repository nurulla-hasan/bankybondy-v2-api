import { model, Schema } from 'mongoose';
import { IChatGroup } from './chatGroup.interface';

const chatGroupSchema = new Schema<IChatGroup>(
    {
        // `required` + `trim`: un ChatGroup sin nombre se renderizaba como "Grupo"
        // (fallback del front). A nivel schema ningún grupo nuevo puede quedar sin
        // nombre. (No afecta docs viejos; sólo valida en creates/saves nuevos.)
        name: {
            type: String,
            required: true,
            trim: true,
        },
        participants: {
            type: [Schema.Types.ObjectId],
            ref: 'NormalUser',
            required: true,
        },
        creator: {
            type: Schema.Types.ObjectId,
            // Typo: decía 'NomralUser'. Es un bug LATENTE, no de datos: `ref` es
            // metadata de schema que Mongoose usa sólo para resolver el populate, no
            // se persiste en los documentos. El primer `.populate('creator')` que
            // alguien escriba tiraba MissingSchemaError → 500. Sin migración.
            ref: 'NormalUser',
            required: true,
        },
        image: {
            type: String,
            default: '',
        },
    },
    { timestamps: true }
);

const ChatGroup = model<IChatGroup>('ChatGroup', chatGroupSchema);
export default ChatGroup;
