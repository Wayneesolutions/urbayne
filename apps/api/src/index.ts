import { createPool } from '@cs/db';
import { loadEnv } from './env.js';
import { createApp } from './app.js';

const env = loadEnv();
const pool = createPool(env.APP_DATABASE_URL);
createApp({ env, pool }).listen(env.PORT, () => console.log(`api (${env.DEPLOY_REGION}) on :${env.PORT}`));
