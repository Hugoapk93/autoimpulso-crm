// ==========================================
// 📥 migrate-to-sqlite.js — migración única de JSON a SQLite
//
// Uso (desde la raíz del proyecto, con el bot DETENIDO):
//   node scripts/migrate-to-sqlite.js              # migra si la BD está vacía
//   node scripts/migrate-to-sqlite.js --dry-run    # solo dice qué migraría
//   node scripts/migrate-to-sqlite.js --force      # reescribe desde los JSON
//
// Qué hace:
// - Lee data/*.json (users, flow, settings, keywords, contacts,
//   subscriptions, agenda, lid_map) y los vuelca a data/crm.db en
//   UNA transacción (todo o nada).
// - Copia los JSON originales a data/backup-json-<timestamp>/.
//   NO los borra: después de verificar, bórralos tú a mano.
// - Un JSON corrupto se respalda como .corrupto-<timestamp> y esa
//   tabla arranca vacía, sin tumbar el resto.
// - Si crm.db ya tiene datos y no pasas --force, no hace nada.
// - Si no hay JSON (instalación nueva), no hace nada.
//
// Nota: con el bot corriendo, initializeDB() ya migra solo la
// primera vez que arranca con crm.db inexistente. Este script es
// para verificar ANTES del reinicio (con --dry-run) o para repetir
// la migración a mano.
// ==========================================
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

const { migrateFromJson, closeDb } = require('../src/database');

const report = migrateFromJson({ dryRun, force });

console.log('--- Migración JSON -> SQLite ---');
console.log(`Modo: ${dryRun ? 'dry-run (no escribe nada)' : force ? 'force' : 'normal'}`);
console.log(`Usuarios: ${report.counts.users} (${report.counts.messages} mensajes)`);
console.log(`Pasos del flujo: ${report.counts.flow}`);
console.log(`Settings: ${report.counts.settings ? 'sí' : 'no hay archivo'}`);
console.log(`Keywords: ${report.counts.keywords}`);
console.log(`Contactos: ${report.counts.contacts}`);
console.log(`Suscripciones push: ${report.counts.subscriptions}`);
console.log(`Citas: ${report.counts.agenda}`);
console.log(`Mappings LID: ${report.counts.lidMap}`);
if (report.warnings.length > 0) {
    console.log('⚠️ Avisos:');
    for (const w of report.warnings) console.log('  - ' + w);
}
if (report.reason === 'no-json') {
    console.log('No hay archivos JSON en data/. Nada que migrar.');
} else if (report.reason === 'db-not-empty') {
    console.log('La BD ya tiene datos. Nada que migrar (usa --force para reescribir desde los JSON).');
} else if (report.reason === 'dry-run') {
    console.log('Dry-run: no se escribió nada en la BD.');
} else if (report.migrated) {
    console.log(`✅ Migrado. Respaldo de los JSON en: ${report.backupDir}`);
    console.log('Verifica con el bot y, cuando todo esté bien, puedes borrar los .json viejos (el respaldo queda).');
}
closeDb();
process.exit(0);
