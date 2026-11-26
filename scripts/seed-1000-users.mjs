#!/usr/bin/env node
/**
 * BankyBondy - 1,000 Users & 10,000 Everyday Bonds Seeding Script
 * 
 * Specifically designed with Emilio's feedback:
 * - Clean previous test users & bonds (preserving admin & settings).
 * - Short, punchy, authentic barter titles (maximum vector embedding accuracy).
 * - Comprehensive coverage of everyday goods & services (fletes, plomería, niñera,
 *   viandas, palas/shovels, radios, anteojos/glasses, bicicletas, herramientas, etc.).
 * - Real OpenAI text-embedding-3-small embeddings computed in fast batches.
 * 
 * Usage:
 *   node scripts/seed-500-users.mjs               (Live run: 1,000 users, 10,000 bonds)
 *   node scripts/seed-500-users.mjs --dry-run     (Simulate without DB writes)
 *   node scripts/seed-500-users.mjs --skip-clean  (Do not delete existing users/bonds)
 *   node scripts/seed-500-users.mjs --clean-only  (Wipe user/bond data only, no seed)
 *   node scripts/seed-500-users.mjs --no-openai   (Use pseudo-vectors only)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DATABASE_URL = process.env.DATABASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const isDryRun = process.argv.includes('--dry-run');
const skipClean = process.argv.includes('--skip-clean');
const cleanOnly = process.argv.includes('--clean-only');
const noOpenAI = process.argv.includes('--no-openai');

const TOTAL_USERS = 1000;
const BONDS_PER_USER = 10;

if (!DATABASE_URL) {
  console.error('❌ Error: DATABASE_URL environment variable is required.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MASTER TAXONOMY: SHORT, PUNCHY & EVERYDAY ESSENTIALS
// ─────────────────────────────────────────────────────────────────────────────

const SERVICES = [
  // 1. Hogar y Oficios
  'Flete y mudanza pequeña',
  'Flete de muebles y bultos',
  'Plomería y destapaciones',
  'Reparación de pérdidas de agua y canillas',
  'Electricidad domiciliaria',
  'Instalación de disyuntores y térmicas',
  'Pintura de paredes e interiores',
  'Pintura de rejas y aberturas',
  'Albañilería y reparaciones menores',
  'Cerrajería y cambio de cerraduras',
  'Reparación y armado de muebles',
  'Instalación y service de aire acondicionado',
  'Colocación de cortinas y cuadros',
  'Colocación de estantes y soportes de TV',
  'Limpieza profunda de casas y oficinas',
  'Limpieza de tapizados y sillones',
  'Impermeabilización de techos y terrazas',
  'Gasista y revisión de artefactos',
  'Reparación de persianas y mosquiteros',

  // 2. Cuidado, Familia y Mascotas
  'Cuidado de niños / Niñera',
  'Acompañamiento de adultos mayores',
  'Paseo diario de perros',
  'Cuidado de gatos a domicilio',
  'Hospedaje canino familiar',
  'Mantenimiento de jardines y pasto',
  'Poda de plantas y limpieza de patio',
  'Armado y mantenimiento de huertas',
  'Peluquería canina y baño',
  'Adiestramiento canino básico',

  // 3. Educación e Idiomas
  'Apoyo escolar primaria',
  'Apoyo escolar secundaria',
  'Clases particulares de matemáticas',
  'Clases de álgebra y análisis matemático',
  'Clases particulares de física',
  'Clases particulares de química',
  'Preparación de ingresos y exámenes finales',
  'Clases de inglés para principiantes',
  'Conversación en inglés',
  'Inglés para viajes y negocios',
  'Clases de portugués de Brasil',
  'Clases de francés inicial',
  'Clases de italiano y conversación',
  'Clases de alemán básico',
  'Clases de español para extranjeros',
  'Traducción de textos inglés-español',
  'Corrección de textos y tesis',

  // 4. Música, Arte y Oficio
  'Clases de guitarra acústica',
  'Clases de guitarra criolla',
  'Clases de guitarra eléctrica',
  'Clases de piano clásico',
  'Clases de teclado y sintetizador',
  'Clases de canto y afinación',
  'Clases de bajo eléctrico',
  'Clases de batería y percusión',
  'Clases de ukelele inicial',
  'Clases de violín',
  'Clases de dibujo y pintura',
  'Taller de cerámica y alfarería',
  'Arreglos de costura y dobladillos',
  'Clases de tejido a crochet',
  'Clases de tango para principiantes',
  'Clases de salsa y bachata',

  // 5. Salud, Bienestar y Deportes
  'Clases de yoga Hatha',
  'Clases de yoga Vinyasa',
  'Clases de Pilates mat',
  'Entrenamiento funcional personalizado',
  'Rutinas guiadas de gimnasio',
  'Sesión de masajes descontracturantes',
  'Sesión de masajes relajantes',
  'Clases de meditación y respiración',
  'Asesoramiento nutricional saludable',
  'Clases particulares de tenis',
  'Clases de pádel iniciación',
  'Clases de natación para adultos',
  'Clases de boxeo recreativo',

  // 6. Tecnología y Digital
  'Reparación de PC y notebook',
  'Limpieza interna y cambio de pasta térmica',
  'Instalación de Windows y disco SSD',
  'Reparación de celulares y pantallas',
  'Diseño de logotipos e imagen de marca',
  'Diseño de banners y flyers para redes',
  'Diseño y creación de páginas web',
  'Desarrollo web en WordPress',
  'Fotografía de producto para e-commerce',
  'Sesión de fotos y retratos',
  'Edición de video para redes sociales',
  'Manejo de redes sociales y community manager',
  'Armado de currículum y perfil de LinkedIn',

  // 7. Cocina y Gastronomía
  'Viandas caseras saludables semanales',
  'Pastelería y tortas caseras',
  'Panadería artesanal y masa madre',
  'Clases de pastas caseras italianas',
  'Clases de cocina práctica y rápida'
];

const GOODS = [
  // 1. Herramientas y Jardín (Incluye Pala / Shovel)
  'Pala de punta para tierra y jardín',
  'Pala ancha para carga y jardín',
  'Rastrillo metálico reforzado',
  'Tijera de podar plantas y arbustos',
  'Manguera de jardín de 15 metros',
  'Taladro percutor eléctrico con mechas',
  'Caja de herramientas completa con llaves',
  'Juego de destornilladores y pinzas',
  'Amoladora angular con discos de corte',
  'Sierra caladora para madera',
  'Martillo y tenaza de carpintero',
  'Nivel de mano y cinta métrica de 5m',
  'Escalera plegable de aluminio',
  'Pistola de calor eléctrica',
  'Lijadora orbital de mano para madera',

  // 2. Electrónica, Audio y Gadgets (Incluye Radio y Anteojos / Glasses)
  'Radio portátil AM/FM a pilas',
  'Radio reloj despertador digital',
  'Anteojos de sol polarizados con estuche',
  'Marcos de anteojos para aumento',
  'Monitor LED 24 pulgadas Full HD',
  'Monitor 27 pulgadas IPS con HDMI',
  'Teclado y mouse inalámbrico',
  'Teclado mecánico retroiluminado',
  'Laptop para oficina y estudio con cargador',
  'Notebook Lenovo ThinkPad usada',
  'Impresora multifunción con escáner',
  'Tablet de 10 pulgadas para lectura',
  'Parlante bluetooth portátil impermeable',
  'Auriculares de diadema para estudio',
  'Auriculares inalámbricos con estuche',
  'Cámara de fotos digital réflex',
  'Trípode de aluminio para cámara y celular',
  'Aro de luz LED con soporte para celular',
  'Cargador portátil power bank 20000 mAh',
  'Disco rígido externo de 1TB USB 3.0',

  // 3. Bicicletas y Movilidad
  'Bicicleta de paseo rodado 26 con canasto',
  'Bicicleta mountain bike rodado 29',
  'Bicicleta plegable rodado 20 para ciudad',
  'Bicicleta playera con asiento cómodo',
  'Casco de ciclista para adulto talle M',
  'Inflador de pie para bicicleta con manómetro',
  'Cadena de seguridad y candado para bici',
  'Alforjas impermeables para bicicleta',
  'Patines rollers extensibles talle 39-41',
  'Monopatín plegable con freno de mano',

  // 4. Electrodomésticos y Cocina
  'Horno microondas digital funcionando',
  'Cafetera espresso manual de acero',
  'Prensa francesa térmica para café',
  'Molinillo de café manual de muelas',
  'Pava eléctrica con corte para mate',
  'Licuadora de vaso de vidrio potente',
  'Tostadora eléctrica de ranura ancha',
  'Minipimer batidora con accesorios',
  'Olla holandesa de hierro fundido',
  'Sartén antiadherente de teflón',
  'Juego de cuchillos de cocina profesionales',
  'Juego de 6 platos y vajilla completa',
  'Set de 6 tazas de cerámica artesanal',
  'Termo de acero inoxidable de 1 litro',
  'Wafflera eléctrica antiadherente',
  'Balanza digital de cocina precisa',

  // 5. Muebles y Hogar
  'Mesa ratona de madera maciza',
  'Juego de 4 sillas de comedor de madera',
  'Escritorio para computadora con cajón',
  'Estantería biblioteca de 5 estantes',
  'Sillón individual tapizado en pana',
  'Lámpara de pie vintage de metal',
  'Lámpara articulada de escritorio',
  'Espejo de cuerpo entero con marco',
  'Perchero de pie de madera maciza',
  'Mesa de noche con cajón y estante',
  'Cortinas de tela para ventana de 2 paños',
  'Alfombra tejida para living o dormitorio',
  'Caloventor eléctrico bajo consumo',
  'Ventilador de pie oscilante 3 velocidades',
  'Juego de 2 almohadones para sillón',

  // 6. Deportes, Camping y Aire Libre
  'Mochila técnica de trekking 50 litros',
  'Carpa iglú para 4 personas impermeable',
  'Bolsa de dormir térmica de montaña',
  'Aislante térmico para piso de carpa',
  'Mesa y bancos plegables de camping',
  'Conservadora térmica de 28 litros',
  'Raqueta de tenis con funda protectora',
  'Paleta de pádel de fibra de carbono',
  'Pesas rusas kettlebell de 8kg y 12kg',
  'Mat de yoga antideslizante con correa',
  'Pelota de básquet oficial de cuero',
  'Pelota de fútbol cosida reglamentaria',

  // 7. Música, Libros, Plantas y Ocio
  'Guitarra criolla clásica con funda',
  'Guitarra eléctrica tipo Stratocaster con cable',
  'Teclado musical de 5 octavas con soporte',
  'Ukelele soprano de madera con afinador',
  'Amplificador de guitarra eléctrica 15W',
  'Tocadiscos estéreo portátil para vinilo',
  'Lote de discos de vinilo de rock nacional',
  'Lote de novelas de literatura clásica',
  'Colección de libros de ciencia ficción',
  'Colección de historietas encuadernadas',
  'Juego de mesa Catan con componentes',
  'Juego de mesa Carcassonne original',
  'Tablero de ajedrez artesanal de madera',
  'Caballete de madera con atril para pintura',
  'Plantas de interior en maceta de barro',
  'Frasco con masa madre activa de centeno',
  'Campera de abrigo para invierno talle M',
  'Valija rígida con ruedas mediana'
];

const SKILL_NAMES = [
  'Guitarra', 'Piano', 'Batería', 'Canto', 'Inglés', 'Francés', 'Italiano', 'Portugués',
  'Mecánica de bicicletas', 'Reparación de PC', 'Programación', 'Diseño gráfico', 'Diseño web',
  'Fotografía', 'Edición de video', 'Pintura', 'Plomería', 'Electricidad', 'Carpintería',
  'Yoga', 'Entrenamiento personal', 'Nutrición', 'Cocina', 'Pastelería', 'Jardinería',
  'Costura', 'Paseo de mascotas', 'Traducción', 'Redacción', 'Matemáticas'
];

const FIRST_NAMES_M = [
  'Juan', 'Carlos', 'Lucas', 'Mateo', 'Santiago', 'Joaquín', 'Nicolás', 'Agustín', 'Lautaro',
  'Tomás', 'Franco', 'Facundo', 'Ignacio', 'Rodrigo', 'Gonzalo', 'Martín', 'Diego', 'Julián',
  'Matías', 'Bruno', 'Esteban', 'Sebastián', 'Federico', 'Maximiliano', 'Manuel', 'Leandro',
  'Patricio', 'Gabriel', 'Alejandro', 'Pablo', 'Ezequiel', 'Damián', 'Marcos', 'Emiliano',
  'Hernán', 'Fernando', 'Mariano', 'Cristian', 'Ramiro', 'Nahuel', 'Ariel', 'Felipe',
  'Guillermo', 'Gustavo', 'Javier', 'Marcelo', 'Mauro', 'Oscar', 'Rafael', 'Sergio'
];

const FIRST_NAMES_F = [
  'Sofía', 'Valentina', 'Martina', 'Camila', 'Isabella', 'Lucía', 'Catalina', 'Elena',
  'Julieta', 'Victoria', 'Florencia', 'Paula', 'Romina', 'Micaela', 'Agustina', 'Luciana',
  'Mariana', 'Carla', 'Daniela', 'Natalia', 'Valeria', 'Sol', 'Abril', 'Rocío', 'Malena',
  'Clara', 'Mora', 'Belén', 'Constanza', 'Guadalupe', 'Jimena', 'Cecilia', 'Gabriela',
  'Anabella', 'Melisa', 'Andrea', 'Carolina', 'Lorena', 'Silvina', 'Brenda', 'Antonella',
  'Barbara', 'Candela', 'Eugenia', 'Gimena', 'Josefina', 'Magalí', 'Milagros', 'Pilar', 'Zoe'
];

const LAST_NAMES = [
  'González', 'Rodríguez', 'Gómez', 'Fernández', 'López', 'Díaz', 'Martínez', 'Pérez',
  'Romero', 'Sánchez', 'Sosa', 'Torres', 'Álvarez', 'Ruiz', 'Ramírez', 'Flores',
  'Benítez', 'Acosta', 'Medina', 'Herrera', 'Aguirre', 'Pereyra', 'Gutiérrez', 'Giménez',
  'Molina', 'Silva', 'Castro', 'Rojas', 'Ortiz', 'Núñez', 'Luna', 'Juárez', 'Cabrera',
  'Ríos', 'Morales', 'Godoy', 'Moreno', 'Ferreyra', 'Domínguez', 'Carrizo', 'Vega',
  'Castillo', 'Ojeda', 'Peralta', 'Quiroga', 'Paz', 'Villalba', 'Navarro', 'Correa'
];

const NEIGHBORHOODS = [
  { name: 'Palermo, CABA', lng: -58.423, lat: -34.582 },
  { name: 'Belgrano, CABA', lng: -58.456, lat: -34.562 },
  { name: 'Recoleta, CABA', lng: -58.392, lat: -34.588 },
  { name: 'Caballito, CABA', lng: -58.443, lat: -34.620 },
  { name: 'Almagro, CABA', lng: -58.421, lat: -34.610 },
  { name: 'San Telmo, CABA', lng: -58.371, lat: -34.621 },
  { name: 'Villa Crespo, CABA', lng: -58.439, lat: -34.598 },
  { name: 'Colegiales, CABA', lng: -58.451, lat: -34.577 },
  { name: 'Núñez, CABA', lng: -58.465, lat: -34.545 },
  { name: 'Saavedra, CABA', lng: -58.490, lat: -34.550 },
  { name: 'Villa Urquiza, CABA', lng: -58.487, lat: -34.573 },
  { name: 'Chacarita, CABA', lng: -58.453, lat: -34.588 },
  { name: 'Barracas, CABA', lng: -58.380, lat: -34.640 },
  { name: 'Flores, CABA', lng: -58.463, lat: -34.630 },
  { name: 'Coghlan, CABA', lng: -58.472, lat: -34.563 },
  { name: 'Vicente López, Buenos Aires', lng: -58.476, lat: -34.528 },
  { name: 'Olivos, Buenos Aires', lng: -58.495, lat: -34.510 },
  { name: 'San Isidro, Buenos Aires', lng: -58.525, lat: -34.472 },
  { name: 'Martínez, Buenos Aires', lng: -58.508, lat: -34.495 },
  { name: 'Tigre, Buenos Aires', lng: -58.580, lat: -34.425 },
  { name: 'Avellaneda, Buenos Aires', lng: -58.365, lat: -34.660 },
  { name: 'Lanús, Buenos Aires', lng: -58.393, lat: -34.700 },
  { name: 'Quilmes, Buenos Aires', lng: -58.260, lat: -34.720 },
  { name: 'Ramos Mejía, Buenos Aires', lng: -58.560, lat: -34.650 }
];

const BIOS = [
  'Apasionado por el intercambio vecinal, la música y el aprendizaje mutuo.',
  'Diseñador y ciclista urbano. Busco colaborar y compartir herramientas y saberes.',
  'Profesor de idiomas, lector curioso y aficionado a la buena cocina casera.',
  'Técnico en informática y aficionado a las reparaciones y el mantenimiento del hogar.',
  'Practicante de yoga y bienestar. Fiel creyente en el trueque y la vida colaborativa.',
  'Estudiante universitario. Dispuesto a dar una mano y aprender nuevos oficios.',
  'Vecino del barrio con ganas de colaborar y compartir cosas útiles que no uso.',
  'Fotógrafo y creativo digital. Siempre abierto a propuestas interesantes de intercambio.',
  'Amante de la jardinería, las plantas y el consumo sustentable.',
  'Cocinero casero y fanático del sonido analógico, los discos y la buena música.'
];

const DESCRIPTIONS_SERVICE = [
  'Coordinamos días y horarios según tu disponibilidad. Modalidad práctica.',
  'Disponible por las tardes o fines de semana. Trabajo prolijo y dedicado.',
  'Con herramientas y materiales propios. Consulta cualquier duda sin compromiso.',
  'Encuentros virtuales o presenciales en punto a convenir en el barrio.',
  'Experiencia y buena predisposición para que el intercambio sea ágil y positivo.'
];

const DESCRIPTIONS_GOOD = [
  'En muy buen estado de conservación y funcionando perfecto. Listo para usar.',
  'Artículo cuidado con poco uso. Se retira por mi zona o punto medio a coordinar.',
  'Lo cambio porque no lo uso actualmente. Completo y en óptimas condiciones.',
  'Impecable estado estético y mecánico, sin faltantes ni roturas.',
  'Probado y listo para entregar en mano. Abierto a propuestas afines.'
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. VECTOR GENERATION (OpenAI batch or normalized pseudo-vector fallback)
// ─────────────────────────────────────────────────────────────────────────────

function pseudoVector(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const v = new Array(1536);
  let mag = 0;
  for (let i = 0; i < 1536; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const val = (((h >>> 0) % 2001) - 1000) / 1000;
    v[i] = val;
    mag += val * val;
  }
  mag = Math.sqrt(mag);
  for (let i = 0; i < 1536; i++) v[i] /= mag;
  return v;
}

async function batchFetchEmbeddings(uniqueTexts, openaiClient) {
  const embeddingMap = new Map();

  if (!openaiClient || noOpenAI) {
    console.log('⚡ Generating pseudo-vectors locally (no OpenAI mode)...');
    for (const t of uniqueTexts) {
      embeddingMap.set(t, pseudoVector(t));
    }
    return embeddingMap;
  }

  console.log(`🌐 Fetching OpenAI embeddings for ${uniqueTexts.length} unique terms via text-embedding-3-small...`);
  const BATCH_SIZE = 1000;
  for (let i = 0; i < uniqueTexts.length; i += BATCH_SIZE) {
    const chunk = uniqueTexts.slice(i, i + BATCH_SIZE);
    try {
      const resp = await openaiClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk,
      });
      for (let j = 0; j < resp.data.length; j++) {
        embeddingMap.set(chunk[j], resp.data[j].embedding);
      }
      console.log(`   Processed ${Math.min(i + BATCH_SIZE, uniqueTexts.length)} / ${uniqueTexts.length} embeddings`);
    } catch (err) {
      console.warn(`   ⚠️ OpenAI batch failed: ${err.message}. Falling back to pseudo-vectors for this chunk.`);
      for (const t of chunk) {
        embeddingMap.set(t, pseudoVector(t));
      }
    }
  }

  return embeddingMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. MAIN SCRIPT
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('====================================================');
  console.log(`🌱 BankyBondy Seeding: ${TOTAL_USERS} Users & ${TOTAL_USERS * BONDS_PER_USER} Bonds`);
  console.log('====================================================');
  console.log(`Target Database : ${DATABASE_URL.replace(/(:\/\/)([^@]+)@/, '$1***:***@')}`);
  console.log(`Dry Run Mode    : ${isDryRun ? 'YES (No changes will be written)' : 'NO (Live update)'}`);
  console.log(`Skip Cleanup    : ${skipClean ? 'YES' : 'NO'}`);
  console.log(`Clean Only      : ${cleanOnly ? 'YES' : 'NO'}`);
  console.log(`OpenAI API Key  : ${OPENAI_API_KEY && !noOpenAI ? 'Present (Real embeddings)' : 'Absent/Skipped (Pseudo-vectors)'}`);
  console.log('====================================================\n');

  await mongoose.connect(DATABASE_URL);
  console.log('✅ Connected to MongoDB successfully.\n');
  const db = mongoose.connection.db;

  const usersCol = db.collection('users');
  const normalUsersCol = db.collection('normalusers');
  const bondRequestsCol = db.collection('bondrequests');
  const bondMatchesCol = db.collection('bondmatches');
  const bondMatchFeedsCol = db.collection('bondmatchfeeds');
  const bondLinksCol = db.collection('bondlinks');
  const bondRatingsCol = db.collection('bondratings');
  const skillsCol = db.collection('skills');
  const conversationsCol = db.collection('conversations');
  const messagesCol = db.collection('messages');
  const notificationsCol = db.collection('notifications');

  // ── Step 1: Cleanup non-admin user data ──────────────────────────────────────
  if (!skipClean) {
    console.log('🧹 Cleaning existing user-level data (preserving superAdmin & admin accounts)...');
    
    const regularUsers = await usersCol.find({ role: 'user' }).project({ _id: 1, profileId: 1 }).toArray();
    const userAuthIds = regularUsers.map((u) => u._id);
    const profileIds = regularUsers
      .map((u) => u.profileId)
      .filter(Boolean)
      .map((pid) => (typeof pid === 'string' && pid.length === 24 ? new mongoose.Types.ObjectId(pid) : pid));

    console.log(`   Found ${userAuthIds.length} existing regular users to clean.`);

    if (!isDryRun) {
      const delBonds = await bondRequestsCol.deleteMany({});
      const delMatches = await bondMatchesCol.deleteMany({});
      const delFeeds = await bondMatchFeedsCol.deleteMany({});
      const delLinks = await bondLinksCol.deleteMany({});
      const delRatings = await bondRatingsCol.deleteMany({});
      const delConvs = await conversationsCol.deleteMany({});
      const delMsgs = await messagesCol.deleteMany({});
      const delNotifs = await notificationsCol.deleteMany({});
      
      let delProfiles = { deletedCount: 0 };
      if (profileIds.length > 0) {
        delProfiles = await normalUsersCol.deleteMany({ _id: { $in: profileIds } });
      }
      const delUsers = await usersCol.deleteMany({ role: 'user' });

      console.log(`   ✅ Deleted ${delBonds.deletedCount} bonds`);
      console.log(`   ✅ Deleted ${delMatches.deletedCount} matches & ${delFeeds.deletedCount} feed rows`);
      console.log(`   ✅ Deleted ${delLinks.deletedCount} links & ${delRatings.deletedCount} ratings`);
      console.log(`   ✅ Deleted ${delConvs.deletedCount} conversations & ${delMsgs.deletedCount} messages`);
      console.log(`   ✅ Deleted ${delNotifs.deletedCount} notifications`);
      console.log(`   ✅ Deleted ${delProfiles.deletedCount} profiles & ${delUsers.deletedCount} auth users`);
    } else {
      console.log('   [Dry Run] Cleanup simulated.');
    }
    console.log('🧹 Cleanup complete.\n');

    if (cleanOnly) {
      console.log('🏁 Clean-only mode completed. Exiting.');
      await mongoose.disconnect();
      return;
    }
  }

  // ── Step 2: Ensure skills exist ─────────────────────────────────────────────
  console.log('🛠️  Ensuring skills are seeded...');
  const skillIdMap = new Map();
  for (const sName of SKILL_NAMES) {
    if (!isDryRun) {
      const res = await skillsCol.findOneAndUpdate(
        { name: sName },
        { $setOnInsert: { name: sName, createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );
      skillIdMap.set(sName, res._id || res.value?._id);
    } else {
      skillIdMap.set(sName, new mongoose.Types.ObjectId());
    }
  }
  const allSkillIds = Array.from(skillIdMap.values()).filter(Boolean);
  console.log(`   Total skills registered: ${allSkillIds.length}`);

  // ── Step 3: Build 1,000 Users ───────────────────────────────────────────────
  console.log(`\n👥 Generating ${TOTAL_USERS} fake users with realistic Argentine profiles...`);
  const salt = await bcrypt.genSalt(10);
  const commonPasswordHash = await bcrypt.hash('User@12345', salt);

  const usersToInsert = [];
  const profilesToInsert = [];

  // Special Emilio test account at index 0
  const emilioUserId = new mongoose.Types.ObjectId();
  const emilioProfileId = new mongoose.Types.ObjectId();
  const emilioEmail = 'emilio.test@bankybondy.com';

  usersToInsert.push({
    _id: emilioUserId,
    profileId: emilioProfileId.toString(),
    email: emilioEmail,
    password: commonPasswordHash,
    role: 'user',
    isVerified: true,
    isActive: true,
    isBlocked: false,
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  profilesToInsert.push({
    _id: emilioProfileId,
    user: emilioUserId,
    name: 'Emilio Test',
    email: emilioEmail,
    bio: 'Cuenta de prueba principal de Emilio para verificar vínculos y coincidencias.',
    address: 'Palermo, CABA',
    skills: allSkillIds.slice(0, 4),
    location: {
      type: 'Point',
      coordinates: [-58.423, -34.582],
    },
    locationUpdatedAt: new Date(),
    locationMode: 'manual',
    reputation: { avg: 4.9, count: 18, score: 0.98 },
    subscriptionType: 'free',
    bondLimit: 25,
    hasActiveBonds: true,
    bondsPublic: true,
    listedInPeople: true,
    socialLinks: [],
    mutedNotificationCategories: [],
    digestOptOut: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Remaining users (999)
  for (let i = 1; i < TOTAL_USERS; i++) {
    const uId = new mongoose.Types.ObjectId();
    const pId = new mongoose.Types.ObjectId();
    const isMale = Math.random() > 0.5;
    const fName = isMale
      ? FIRST_NAMES_M[Math.floor(Math.random() * FIRST_NAMES_M.length)]
      : FIRST_NAMES_F[Math.floor(Math.random() * FIRST_NAMES_F.length)];
    const lName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    const fullName = `${fName} ${lName}`;
    const email = `user${i}@bankybondy.dev`;

    const hood = NEIGHBORHOODS[Math.floor(Math.random() * NEIGHBORHOODS.length)];
    const lng = Number((hood.lng + (Math.random() - 0.5) * 0.030).toFixed(6));
    const lat = Number((hood.lat + (Math.random() - 0.5) * 0.030).toFixed(6));
    const bio = BIOS[Math.floor(Math.random() * BIOS.length)];

    const numSkills = 2 + Math.floor(Math.random() * 3);
    const shuffledSkills = [...allSkillIds].sort(() => 0.5 - Math.random()).slice(0, numSkills);

    const repAvg = Number((4.1 + Math.random() * 0.9).toFixed(1));
    const repCount = Math.floor(1 + Math.random() * 25);
    const repScore = Number((repAvg / 5).toFixed(2));

    usersToInsert.push({
      _id: uId,
      profileId: pId.toString(),
      email,
      password: commonPasswordHash,
      role: 'user',
      isVerified: true,
      isActive: true,
      isBlocked: false,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    profilesToInsert.push({
      _id: pId,
      user: uId,
      name: fullName,
      email,
      bio,
      address: hood.name,
      skills: shuffledSkills,
      location: {
        type: 'Point',
        coordinates: [lng, lat],
      },
      locationUpdatedAt: new Date(),
      locationMode: 'manual',
      reputation: { avg: repAvg, count: repCount, score: repScore },
      subscriptionType: 'free',
      bondLimit: 25,
      hasActiveBonds: true,
      bondsPublic: true,
      listedInPeople: true,
      socialLinks: [],
      mutedNotificationCategories: [],
      digestOptOut: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  console.log(`   Generated ${usersToInsert.length} user auth and profile pairs.`);

  if (!isDryRun) {
    console.log('💾 Inserting users into MongoDB in batches of 500...');
    for (let i = 0; i < usersToInsert.length; i += 500) {
      await usersCol.insertMany(usersToInsert.slice(i, i + 500));
      await normalUsersCol.insertMany(profilesToInsert.slice(i, i + 500));
    }
    console.log(`   ✅ Inserted ${TOTAL_USERS} Users & NormalUsers into MongoDB.`);
  }

  // ── Step 4: Build 10,000 Bonds with Pure Punchy Master Taxonomy ─────────────
  console.log(`\n📜 Generating ${TOTAL_USERS * BONDS_PER_USER} bonds (${BONDS_PER_USER} per user) from Master Taxonomy...`);

  const ALL_ITEMS = [...SERVICES, ...GOODS];
  const uniqueTermsSet = new Set(ALL_ITEMS);
  uniqueTermsSet.add('surprise');
  uniqueTermsSet.add('empty');
  const uniqueTermsList = Array.from(uniqueTermsSet);
  console.log(`   Master taxonomy has ${uniqueTermsList.length} distinct, punchy goods, services & wildcards.`);

  let openaiClient = null;
  if (OPENAI_API_KEY && !noOpenAI) {
    openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  }

  const embeddingCache = await batchFetchEmbeddings(uniqueTermsList, openaiClient);

  const bondsRaw = [];
  const globalPairsSeen = new Set();

  for (let uIdx = 0; uIdx < profilesToInsert.length; uIdx++) {
    const profile = profilesToInsert[uIdx];
    const userCoords = profile.location.coordinates;
    const userOffersSeen = new Set();
    const userWantsSeen = new Set();

    let bondsForThisUser = 0;
    let attempts = 0;

    while (bondsForThisUser < BONDS_PER_USER && attempts < 250) {
      attempts++;

      let offer, want, isServiceOffer;
      const roll = Math.random();

      if (roll < 0.90) {
        offer = ALL_ITEMS[Math.floor(Math.random() * ALL_ITEMS.length)];
        want = ALL_ITEMS[Math.floor(Math.random() * ALL_ITEMS.length)];
        isServiceOffer = SERVICES.includes(offer);
      } else if (roll < 0.95) {
        if (Math.random() > 0.5) {
          offer = 'surprise';
          want = ALL_ITEMS[Math.floor(Math.random() * ALL_ITEMS.length)];
          isServiceOffer = false;
        } else {
          offer = ALL_ITEMS[Math.floor(Math.random() * ALL_ITEMS.length)];
          want = 'surprise';
          isServiceOffer = SERVICES.includes(offer);
        }
      } else {
        if (Math.random() > 0.5) {
          offer = 'empty';
          want = ALL_ITEMS[Math.floor(Math.random() * ALL_ITEMS.length)];
          isServiceOffer = false;
        } else {
          offer = ALL_ITEMS[Math.floor(Math.random() * ALL_ITEMS.length)];
          want = 'empty';
          isServiceOffer = SERVICES.includes(offer);
        }
      }

      const offerKey = offer.trim().toLowerCase();
      const wantKey = want.trim().toLowerCase();

      // Offer and want must not be identical
      if (offerKey === wantKey) continue;

      // Single user must have 10 distinct offers and wants
      if (userOffersSeen.has(offerKey) || userWantsSeen.has(wantKey)) continue;

      // Unique pair signature
      const pairSig = `${offerKey}:::${wantKey}`;
      if (globalPairsSeen.has(pairSig)) continue;

      globalPairsSeen.add(pairSig);
      userOffersSeen.add(offerKey);
      userWantsSeen.add(wantKey);

      const descList = isServiceOffer ? DESCRIPTIONS_SERVICE : DESCRIPTIONS_GOOD;
      const desc = descList[Math.floor(Math.random() * descList.length)];

      const isPhysical = Math.random() < 0.65;
      const modality = isPhysical ? 'physical' : 'online';
      const radius = isPhysical ? [5, 10, 15, 20, 30][Math.floor(Math.random() * 5)] : undefined;
      const bondLocation = isPhysical ? { type: 'Point', coordinates: userCoords } : undefined;

      const createdDaysAgo = Math.floor(Math.random() * 28);
      const createdAt = new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000);

      bondsRaw.push({
        _id: new mongoose.Types.ObjectId(),
        user: profile._id,
        offer,
        want,
        offerKey,
        wantKey,
        description: desc,
        status: 'WAITING_FOR_LINK',
        modality,
        radius,
        location: bondLocation,
        isLinked: false,
        isPause: false,
        isDeleted: false,
        createdAt,
        updatedAt: createdAt,
      });

      bondsForThisUser++;
    }
  }

  console.log(`   Generated ${bondsRaw.length} bonds with ${globalPairsSeen.size} globally unique pair combinations.`);

  // ── Step 5: Assign Vectors & Bulk Insert ────────────────────────────────────
  const bondsToInsert = bondsRaw.map((b) => ({
    ...b,
    offerVector: embeddingCache.get(b.offer) || pseudoVector(b.offer),
    wantVector: embeddingCache.get(b.want) || pseudoVector(b.want),
    matchesComputedAt: b.createdAt,
    matchesNextAt: new Date(0), // Due for worker recompute immediately
    matchesGen: 0,
  }));

  if (!isDryRun) {
    console.log(`\n💾 Inserting ${bondsToInsert.length} bonds into MongoDB in batches of 1,000...`);
    const BATCH = 1000;
    for (let i = 0; i < bondsToInsert.length; i += BATCH) {
      const chunk = bondsToInsert.slice(i, i + BATCH);
      await bondRequestsCol.insertMany(chunk);
      console.log(`   Inserted ${Math.min(i + BATCH, bondsToInsert.length)} / ${bondsToInsert.length} bonds`);
    }
  }

  // ── Step 6: Summary & Final Verification ─────────────────────────────────────
  console.log('\n====================================================');
  console.log('🎉 SEEDING COMPLETED SUCCESSFULLY!');
  console.log('====================================================');
  console.log(`Total Users Created        : ${profilesToInsert.length}`);
  console.log(`Total Bonds Created        : ${bondsToInsert.length}`);
  console.log(`Globally Unique Pairs      : ${globalPairsSeen.size} distinct combinations`);
  console.log(`Master Taxonomy Terms      : ${ALL_ITEMS.length} short punchy categories`);
  console.log(`Default User Password      : User@12345`);
  console.log('----------------------------------------------------');
  console.log('🔑 Test Accounts:');
  console.log('   - Emilio Account         : emilio.test@bankybondy.com / User@12345');
  console.log('   - User 1                 : user1@bankybondy.dev / User@12345');
  console.log('   - User 500               : user500@bankybondy.dev / User@12345');
  console.log('====================================================\n');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
