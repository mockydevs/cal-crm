import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { configuration } from './config.js';
import { createCrmMcpServer } from './server.js';

const server = createCrmMcpServer(configuration(process.env));
await server.connect(new StdioServerTransport());
