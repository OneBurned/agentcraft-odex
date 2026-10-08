import { main } from './foreman/src/setup.mjs';
await main().catch(e => { console.error(e.message); process.exitCode = 1; });
