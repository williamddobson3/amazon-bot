import { migrate } from './mysql.js';

migrate()
  .then(() => { console.log('Migration done'); process.exit(0); })
  .catch((err) => { console.error(err); process.exit(1); });
