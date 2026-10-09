// Loads server/.env regardless of the current working directory
// (important when an MCP client or process manager starts the server from elsewhere).
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../.env'), quiet: true });
