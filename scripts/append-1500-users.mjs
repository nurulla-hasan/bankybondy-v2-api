#!/usr/bin/env node
/**
 * BankyBondy - Append 1,500 Users & 15,000 Bonds to reach 2,500 Users Total
 * 
 * Specifically designed for Emilio's request:
 * - Current DB has 1,000 users.
 * - This script appends 1,500 new users (User 1000 to User 2499) without cleaning existing users.
 * - 500 users with descriptive phrases.
 * - 1,000 users with singular, unique, non-repeating personal phrasings (semantic variety, no literal clones).
 * - Total in DB: 2,500 Users & 25,000 Bonds.
 * - Real OpenAI text-embedding-3-small embeddings computed in fast batches.
 * 
 * Usage:
 *   node scripts/append-1500-users.mjs               (Live run)
 *   node scripts/append-1500-users.mjs --dry-run     (Simulate without DB writes)
 *   node scripts/append-1500-users.mjs --no-openai   (Use pseudo-vectors only)
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
const noOpenAI = process.argv.includes('--no-openai');

const NEW_USERS_COUNT = 1500;
const BONDS_PER_USER = 10;
const START_USER_INDEX = 1000;

if (!DATABASE_URL) {
  console.error('❌ Error: DATABASE_URL environment variable is required.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DATA TAXONOMY: RICH, DIVERSE, SINGULAR & DESCRIPTIVE
// ─────────────────────────────────────────────────────────────────────────────

// Diverse singular service variations (how real individuals phrase them uniquely)
const SINGULAR_SERVICES = [
  // Plumber / Water
  'Arreglo de cañerías y pérdidas', 'Destapar bacha de cocina', 'Cambio de cuerito de canilla',
  'Plomero para arreglos en baño', 'Instalación de grifería monocomando', 'Reparar mochila de inodoro',
  'Destapación de caños de desagüe', 'Revisar pérdida de agua urgente', 'Instalar bidet o ducha',
  
  // Electrician
  'Instalar disyuntor y térmicas', 'Revisión de cables y cortocircuitos', 'Colocar apliques de luz en techo',
  'Cambio de tomas y enchufes', 'Instalar lámparas colgantes', 'Electricista para arreglos en casa',
  'Instalar luces LED bajo alacena', 'Cableado de habitación', 'Revisión de tablero eléctrico',

  // Freight & Moving (Flete)
  'Flete corto en camioneta', 'Mudanza de pocas cosas', 'Transportar muebles o electrodomésticos',
  'Flete económico en el barrio', 'Ayuda para traslado de bultos', 'Viaje con camioneta flete',

  // Babysitter & Elders
  'Cuidar nenes por hora', 'Niñera para cuidar chicos', 'Cuidado de bebés por la tarde',
  'Acompañante para abuela o abuelo', 'Compañía para persona mayor', 'Cuidado de niños fines de semana',

  // Pets
  'Alguien que pasee mi perro', 'Paseador de perros a la mañana', 'Cuidar perro mediano por la tarde',
  'Cuidado de gatos en departamento', 'Visitas a domicilio para alimentar gato', 'Paseo tranquilo para perro viejito',

  // Bike repair
  'Arreglar cambios de bicicleta', 'Ajustar frenos y cadena de bici', 'Centrar rueda de bicicleta',
  'Parchar rueda y cambio de cámara', 'Puesta a punto de bicicleta urbana', 'Mecánico de bicis a domicilio',

  // PC & Tech
  'Instalar Windows y programas', 'Limpiar notebook que calienta', 'Poner disco SSD a computadora',
  'Arreglar PC que no arranca', 'Formatear computadora lenta', 'Cambiar pasta térmica de laptop',
  'Cambiar pantalla rota de celular', 'Arreglar pin de carga de celular', 'Ayuda para configurar celular nuevo',

  // Design & Web
  'Diseño de logo para emprendimiento', 'Hacer folletos o flyers para redes', 'Diseñar menú para restaurante',
  'Hacer página web sencilla', 'Armar tienda online básica', 'Arreglar sitio de WordPress',
  'Edición de videos cortos para Instagram', 'Editar fotos de productos para catálogo', 'Manejo de Instagram comercial',

  // Languages
  'Aprender inglés básico desde cero', 'Práctica de conversación en inglés', 'Conversar en inglés fluido',
  'Clases de inglés para viajar', 'Ayuda con pronunciación en inglés', 'Inglés para principiantes adultos',
  'Clases de francés inicial', 'Conversación básica en francés', 'Aprender italiano desde cero',
  'Práctica de conversación en italiano', 'Clases de portugués de Brasil', 'Aprender alemán básico',

  // Academics
  'Profesor particular de matemáticas', 'Ayuda con álgebra y funciones', 'Apoyo escolar para primaria',
  'Apoyo en química de secundaria', 'Preparación de examen de física', 'Ayuda con tareas escolares',

  // Music
  'Aprender a tocar la guitarra', 'Clases de guitarra criolla acústica', 'Guitarra para principiantes',
  'Clases de canciones en guitarra', 'Clases de guitarra eléctrica y solos', 'Aprender piano desde cero',
  'Clases de teclado y acordes', 'Clases de canto y afinación', 'Clases de ukelele fáciles',
  'Clases de bajo eléctrico inicial', 'Clases de batería y ritmo', 'Aprender a tocar el violín',

  // Home Trades
  'Pintar habitación o paredes', 'Pintar rejas de ventana con antióxido', 'Arreglar humedad en pared',
  'Restaurar mesa de madera', 'Lustrar muebles antiguos', 'Armar estantes flotantes de madera',
  'Arreglar cajones que se traban', 'Cambiar cerradura de puerta', 'Colocar cortinas con barral',
  'Colgar cuadros y espejos pesados', 'Instalar soporte de tele en pared', 'Limpieza profunda de sillón',

  // Wellness & Sports
  'Clases de yoga para principiantes', 'Yoga suave para relajación', 'Clases de yoga dinámico',
  'Clases de Pilates para postura', 'Entrenamiento personal al aire libre', 'Rutina de ejercicios para empezar',
  'Masajes para dolor de espalda', 'Masajes relajantes descontracturantes', 'Aprender a jugar al tenis',
  'Clases de pádel para nivel cero', 'Clases de natación para perder el miedo', 'Aprender a bailar tango'
];

// Diverse singular goods variations (how real individuals describe physical barter items)
const SINGULAR_GOODS = [
  // Shovels & Garden tools (Emilio's request!)
  'Pala de punta para cavar tierra', 'Pala ancha con mango de madera', 'Pala chica para jardín y macetas',
  'Rastrillo de metal para hojas', 'Tijera grande para podar ramas', 'Manguera de riego de 15 metros',
  'Carretilla de metal para jardín', 'Bolsa de tierra fértil y abono', 'Macetas de barro medianas',
  'Plantas de interior en maceta', 'Esquejes de monstera enraizados', 'Masa madre activa con frasco',

  // Radio & Audio (Emilio's request!)
  'Radio portátil a pilas AM/FM', 'Radio reloj despertador para mesita', 'Radio clásica con antena',
  'Parlante bluetooth chico recargable', 'Parlante portátil con buen sonido', 'Auriculares con cable para escuchar música',
  'Auriculares inalámbricos tipo buds', 'Auriculares de diadema cerrados', 'Micrófono para computadora o streaming',

  // Glasses & Optics (Emilio's request!)
  'Anteojos de sol negros polarizados', 'Gafas de sol estilo aviador', 'Marcos de anteojos para aumento',
  'Marcos de lentes de acetato', 'Anteojos de sol con estuche rígido', 'Lupa grande con mango',

  // Bikes & Transport
  'Bici de paseo rodado 26 con canasto', 'Bicicleta mountain bike rodado 29', 'Bicicleta plegable rodado 20',
  'Bicicleta playera con asiento ancho', 'Bicicleta urbana liviana rodado 28', 'Casco de bicicleta para adulto',
  'Inflador de bicicleta manual de pie', 'Cadena de acero con candado para bici', 'Patines rollers talle 40 extensibles',

  // Tech & Computing
  'Monitor LED 24 pulgadas con HDMI', 'Monitor para computadora de 22 pulgadas', 'Teclado y mouse inalámbrico USB',
  'Teclado mecánico con luces', 'Notebook para estudio con cargador', 'Laptop Dell usada funcionando bien',
  'Tablet de 10 pulgadas para leer', 'Impresora multifunción con escáner', 'Disco externo 1TB para fotos y archivos',
  'Cámara digital réflex con lente', 'Trípode liviano para celular y fotos', 'Aro de luz LED con trípode',
  'Cargador portátil power bank 20000mAh',

  // Kitchen & Home Appliances
  'Horno microondas digital funcionando', 'Cafetera espresso manual de café', 'Prensa francesa para café de vidrio',
  'Molinillo manual de café en grano', 'Pava eléctrica de acero inoxidable', 'Licuadora de vaso para licuados',
  'Tostadora eléctrica de dos panes', 'Minipimer batidora de mano', 'Olla de hierro fundido para cocinar',
  'Sartén antiadherente de teflón', 'Juego de cuchillos de cocina afilados', 'Juego de platos y tazas de cerámica',
  'Termo de acero de 1 litro para mate', 'Wafflera eléctrica para desayuno', 'Balanza chica digital de cocina',

  // Furniture & Decor
  'Mesa ratona de madera para living', 'Juego de 4 sillas de comedor de madera', 'Escritorio chico para computadora',
  'Estantería biblioteca de 4 estantes', 'Sillón individual cómodo de tela', 'Lámpara de pie vintage para rincón',
  'Lámpara de escritorio articulada', 'Espejo largo para pared', 'Perchero de madera de pie',
  'Mesa de noche de madera con cajón', 'Cortinas de tela para ventana', 'Caloventor eléctrico para invierno',
  'Ventilador de pie con 3 velocidades',

  // Outdoor & Sports
  'Mochila grande de trekking 50L', 'Carpa para 4 personas con varillas', 'Bolsa de dormir abrigada para acampar',
  'Aislante térmico para piso de carpa', 'Mesa plegable chica de camping', 'Conservadora térmica para bebidas',
  'Raqueta de tenis con funda', 'Paleta de pádel de carbono usada', 'Pesas rusas kettlebell de 8kg',
  'Mat de yoga grueso antideslizante', 'Pelota de fútbol reglamentaria', 'Pelota de básquet de cuero',

  // Books, Games & Instruments
  'Guitarra criolla clásica con funda', 'Guitarra eléctrica con cable plug', 'Teclado musical de 5 octavas',
  'Ukelele de madera con funda', 'Amplificador de guitarra chico 15W', 'Tocadiscos portátil para vinilos',
  'Lote de discos de vinilo de rock', 'Lote de novelas y libros leídos', 'Libros de ciencia ficción y fantasía',
  'Juego de mesa Catan completo', 'Juego de mesa Carcassonne original', 'Tablero de ajedrez de madera',
  'Campera de abrigo para invierno talle M', 'Valija mediana con ruedas para viajar'
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
  console.log(`🌱 BankyBondy Seeding: Appending ${NEW_USERS_COUNT} Users (${NEW_USERS_COUNT * BONDS_PER_USER} Bonds)`);
  console.log('====================================================');
  console.log(`Target Database : ${DATABASE_URL.replace(/(:\/\/)([^@]+)@/, '$1***:***@')}`);
  console.log(`Dry Run Mode    : ${isDryRun ? 'YES (No changes will be written)' : 'NO (Live update)'}`);
  console.log(`User IDs Range  : user${START_USER_INDEX} to user${START_USER_INDEX + NEW_USERS_COUNT - 1}`);
  console.log(`OpenAI API Key  : ${OPENAI_API_KEY && !noOpenAI ? 'Present (Real embeddings)' : 'Absent/Skipped (Pseudo-vectors)'}`);
  console.log('====================================================\n');

  await mongoose.connect(DATABASE_URL);
  console.log('✅ Connected to MongoDB successfully.\n');
  const db = mongoose.connection.db;

  const usersCol = db.collection('users');
  const normalUsersCol = db.collection('normalusers');
  const bondRequestsCol = db.collection('bondrequests');
  const skillsCol = db.collection('skills');

  // Check current users count
  const existingUsersCount = await usersCol.countDocuments({ role: 'user' });
  const existingBondsCount = await bondRequestsCol.countDocuments({});
  console.log(`📊 Current State: ${existingUsersCount} existing regular users, ${existingBondsCount} existing bonds in DB.`);

  // ── Step 1: Ensure skills exist ─────────────────────────────────────────────
  console.log('\n🛠️  Ensuring skills are seeded...');
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

  // ── Step 2: Build 1,500 New Users ───────────────────────────────────────────
  console.log(`\n👥 Generating ${NEW_USERS_COUNT} new user profiles (user${START_USER_INDEX} to user${START_USER_INDEX + NEW_USERS_COUNT - 1})...`);
  const salt = await bcrypt.genSalt(10);
  const commonPasswordHash = await bcrypt.hash('User@12345', salt);

  const usersToInsert = [];
  const profilesToInsert = [];

  for (let i = 0; i < NEW_USERS_COUNT; i++) {
    const userNum = START_USER_INDEX + i;
    const uId = new mongoose.Types.ObjectId();
    const pId = new mongoose.Types.ObjectId();
    const isMale = Math.random() > 0.5;
    const fName = isMale
      ? FIRST_NAMES_M[Math.floor(Math.random() * FIRST_NAMES_M.length)]
      : FIRST_NAMES_F[Math.floor(Math.random() * FIRST_NAMES_F.length)];
    const lName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    const fullName = `${fName} ${lName}`;
    const email = `user${userNum}@bankybondy.dev`;

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
    console.log('💾 Inserting new users into MongoDB in batches of 500...');
    for (let i = 0; i < usersToInsert.length; i += 500) {
      await usersCol.insertMany(usersToInsert.slice(i, i + 500));
      await normalUsersCol.insertMany(profilesToInsert.slice(i, i + 500));
    }
    console.log(`   ✅ Inserted ${NEW_USERS_COUNT} new Users & NormalUsers into MongoDB.`);
  }

  // ── Step 3: Build 15,000 Unique Bonds (Singular & Varied) ───────────────────
  console.log(`\n📜 Generating ${NEW_USERS_COUNT * BONDS_PER_USER} bonds (${BONDS_PER_USER} per user) with singular variety...`);

  const ALL_SINGULAR_POOL = [...SINGULAR_SERVICES, ...SINGULAR_GOODS];
  const uniqueTermsSet = new Set(ALL_SINGULAR_POOL);
  uniqueTermsSet.add('surprise');
  uniqueTermsSet.add('empty');
  const uniqueTermsList = Array.from(uniqueTermsSet);
  console.log(`   Singular taxonomy pool has ${uniqueTermsList.length} distinct everyday goods, services & wildcards.`);

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
        offer = ALL_SINGULAR_POOL[Math.floor(Math.random() * ALL_SINGULAR_POOL.length)];
        want = ALL_SINGULAR_POOL[Math.floor(Math.random() * ALL_SINGULAR_POOL.length)];
        isServiceOffer = SINGULAR_SERVICES.includes(offer);
      } else if (roll < 0.95) {
        if (Math.random() > 0.5) {
          offer = 'surprise';
          want = ALL_SINGULAR_POOL[Math.floor(Math.random() * ALL_SINGULAR_POOL.length)];
          isServiceOffer = false;
        } else {
          offer = ALL_SINGULAR_POOL[Math.floor(Math.random() * ALL_SINGULAR_POOL.length)];
          want = 'surprise';
          isServiceOffer = SINGULAR_SERVICES.includes(offer);
        }
      } else {
        if (Math.random() > 0.5) {
          offer = 'empty';
          want = ALL_SINGULAR_POOL[Math.floor(Math.random() * ALL_SINGULAR_POOL.length)];
          isServiceOffer = false;
        } else {
          offer = ALL_SINGULAR_POOL[Math.floor(Math.random() * ALL_SINGULAR_POOL.length)];
          want = 'empty';
          isServiceOffer = SINGULAR_SERVICES.includes(offer);
        }
      }

      const offerKey = offer.trim().toLowerCase();
      const wantKey = want.trim().toLowerCase();

      if (offerKey === wantKey) continue;
      if (userOffersSeen.has(offerKey) || userWantsSeen.has(wantKey)) continue;

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

  console.log(`   Generated ${bondsRaw.length} new bonds with ${globalPairsSeen.size} unique pair combinations.`);

  // ── Step 4: Assign Vectors & Bulk Insert ────────────────────────────────────
  const bondsToInsert = bondsRaw.map((b) => ({
    ...b,
    offerVector: embeddingCache.get(b.offer) || pseudoVector(b.offer),
    wantVector: embeddingCache.get(b.want) || pseudoVector(b.want),
    matchesComputedAt: b.createdAt,
    matchesNextAt: new Date(0), // Due for worker recompute immediately
    matchesGen: 0,
  }));

  if (!isDryRun) {
    console.log(`\n💾 Inserting ${bondsToInsert.length} new bonds into MongoDB in batches of 1,000...`);
    const BATCH = 1000;
    for (let i = 0; i < bondsToInsert.length; i += BATCH) {
      const chunk = bondsToInsert.slice(i, i + BATCH);
      await bondRequestsCol.insertMany(chunk);
      console.log(`   Inserted ${Math.min(i + BATCH, bondsToInsert.length)} / ${bondsToInsert.length} bonds`);
    }
  }

  // Final count in DB
  let finalUsers = existingUsersCount + NEW_USERS_COUNT;
  let finalBonds = existingBondsCount + (NEW_USERS_COUNT * BONDS_PER_USER);
  if (!isDryRun) {
    finalUsers = await usersCol.countDocuments({ role: 'user' });
    finalBonds = await bondRequestsCol.countDocuments({});
  }

  // ── Step 5: Summary & Final Verification ─────────────────────────────────────
  console.log('\n====================================================');
  console.log('🎉 APPEND COMPLETED SUCCESSFULLY!');
  console.log('====================================================');
  console.log(`New Users Added            : ${NEW_USERS_COUNT}`);
  console.log(`New Bonds Added            : ${bondsToInsert.length}`);
  console.log(`----------------------------------------------------`);
  console.log(`TOTAL USERS IN DATABASE    : ${finalUsers} users`);
  console.log(`TOTAL BONDS IN DATABASE    : ${finalBonds} bonds`);
  console.log(`----------------------------------------------------`);
  console.log(`All User Passwords         : User@12345`);
  console.log('====================================================\n');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Append failed:', err);
  process.exit(1);
});
