/**
 * Emits machine contracts into packages/contracts/json and (with --check) fails on drift.
 *
 *   json/drop-v1.schema.json   request payload schema
 *   json/send-envelope.schema.json
 *   json/mcp-tools.json        tool list per toolset with JSON Schema input/output
 *   json/openapi.json          HTTP contract (subset used by bridge + web)
 *   json/error-codes.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  apiErrorSchema,
  dropPayloadV1Schema,
  ERROR_CODES,
  H_ROUTES,
  PUBLIC_ROUTES,
  type RouteContract,
  sendEnvelopeSchema,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  TOOLSETS,
  USER_ROUTES,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'json');
const check = process.argv.includes('--check');

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): unknown {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' });
}

function stable(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const files: Record<string, unknown> = {};

files['drop-v1.schema.json'] = {
  $id: 'urn:agentdrop:schema:drop-v1',
  ...(toJsonSchema(dropPayloadV1Schema) as object),
};
files['send-envelope.schema.json'] = {
  $id: 'urn:agentdrop:schema:send-envelope',
  ...(toJsonSchema(sendEnvelopeSchema) as object),
};
files['error-codes.json'] = ERROR_CODES;

files['mcp-tools.json'] = {
  contract_version: '0.2',
  toolsets: TOOLSETS,
  tools: TOOL_NAMES.map((name) => {
    const def = TOOL_DEFINITIONS[name];
    return {
      name,
      description: def.description,
      annotations: def.annotations,
      inputSchema: toJsonSchema(def.inputSchema),
      outputSchema: toJsonSchema(def.outputSchema, 'output'),
    };
  }),
};

function openapiPath(route: RouteContract) {
  const params = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  const op: Record<string, unknown> = {
    summary: route.summary,
    security:
      route.auth === 'none'
        ? []
        : route.auth === 'h_credential'
          ? [{ hCredential: [] }]
          : [{ sessionCookie: [] }],
    parameters: params,
    responses: {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: toJsonSchema(route.response, 'output') } },
      },
      default: {
        description: 'Error',
        content: { 'application/json': { schema: toJsonSchema(apiErrorSchema, 'output') } },
      },
    },
  };
  if (route.query) {
    const qs = toJsonSchema(route.query) as { properties?: Record<string, unknown>; required?: string[] };
    for (const [name, schema] of Object.entries(qs.properties ?? {})) {
      (op.parameters as unknown[]).push({
        name,
        in: 'query',
        required: qs.required?.includes(name) ?? false,
        schema,
      });
    }
  }
  if (route.body) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: toJsonSchema(route.body) } },
    };
  }
  return op;
}

const paths: Record<string, Record<string, unknown>> = {};
for (const route of [
  ...Object.values(PUBLIC_ROUTES),
  ...Object.values(H_ROUTES),
  ...Object.values(USER_ROUTES),
] as RouteContract[]) {
  paths[route.path] ??= {};
  paths[route.path][route.method.toLowerCase()] = openapiPath(route);
}
files['openapi.json'] = {
  openapi: '3.1.0',
  info: { title: 'AgentDrop API', version: '0.2.0' },
  components: {
    securitySchemes: {
      hCredential: {
        type: 'http',
        scheme: 'bearer',
        description: 'Opaque credential bound to exactly one H',
      },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
    },
  },
  paths,
};

mkdirSync(outDir, { recursive: true });
let drift = false;
for (const [name, value] of Object.entries(files)) {
  const target = join(outDir, name);
  const next = stable(value);
  if (check) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = '';
    }
    if (current !== next) {
      drift = true;
      console.error(`[contracts] drift detected: ${name} (run pnpm contracts:generate)`);
    }
  } else {
    writeFileSync(target, next);
    console.log(`[contracts] wrote ${name} (${Buffer.byteLength(next)} bytes)`);
  }
}

const toolsListBytes = Buffer.byteLength(
  JSON.stringify(
    TOOLSETS.standard.map((n) => ({
      name: n,
      description: TOOL_DEFINITIONS[n].description,
      inputSchema: toJsonSchema(TOOL_DEFINITIONS[n].inputSchema),
    })),
  ),
);
console.log(
  `[contracts] canonical standard tools/list JSON size: ${toolsListBytes} UTF-8 bytes (not a token measurement)`,
);

if (check && drift) process.exit(1);
