import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
	browserRequestAllowed,
	bearerMatches,
	directLoopbackBearerRouteAllowed,
	isLoopbackOrigin,
	localApiToken,
} from '../src/local-api-gate.ts';

function workspace(): string {
	return mkdtempSync(join(tmpdir(), 'sutando-local-api-gate-'));
}

describe('local API token parity', () => {
	it('reads a token minted by the Python helper at the same status path', () => {
		const ws = workspace();
		try {
			const pythonToken = execFileSync('python3', ['-c', [
				'import sys',
				"sys.path.insert(0, 'src')",
				'from pathlib import Path',
				'from local_api_gate import local_api_token',
				'print(local_api_token(Path(sys.argv[1])))',
			].join('; '), ws], { encoding: 'utf8' }).trim();
			assert.ok(pythonToken);
			assert.equal(localApiToken(ws, ''), pythonToken);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it('writes a Python-readable 0600 token with a trailing newline', () => {
		const ws = workspace();
		try {
			const token = localApiToken(ws, '');
			const path = join(ws, 'state', 'agent-api.token');
			assert.equal(readFileSync(path, 'utf8'), `${token}\n`);
			assert.equal(statSync(path).mode & 0o777, 0o600);
			const pythonToken = execFileSync('python3', ['-c', [
				'import sys',
				"sys.path.insert(0, 'src')",
				'from pathlib import Path',
				'from local_api_gate import local_api_token',
				'print(local_api_token(Path(sys.argv[1])))',
			].join('; '), ws], { encoding: 'utf8' }).trim();
			assert.equal(pythonToken, token);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it('concurrent first-use publishers all return the hard-link winner', async () => {
		const ws = workspace();
		const moduleUrl = new URL('../src/local-api-gate.ts', import.meta.url).href;
		const script = `import { localApiToken } from ${JSON.stringify(moduleUrl)}; process.stdout.write(localApiToken(process.argv[1], ''));`;
		try {
			const tokens = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
				const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, ws], {
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				let output = '';
				let error = '';
				child.stdout.on('data', chunk => { output += String(chunk); });
				child.stderr.on('data', chunk => { error += String(chunk); });
				child.once('error', reject);
				child.once('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
			})));
			assert.ok(tokens.every(token => token === tokens[0]));
			assert.equal(readFileSync(join(ws, 'state', 'agent-api.token'), 'utf8'), `${tokens[0]}\n`);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
});

describe('bearerMatches', () => {
	it('accepts bare and case-insensitive Bearer credentials, rejects empty and unequal values', () => {
		assert.equal(bearerMatches('Bearer secret', 'secret'), true);
		assert.equal(bearerMatches('bEaReR secret', 'secret'), true);
		assert.equal(bearerMatches(' secret ', 'secret'), true);
		assert.equal(bearerMatches('Bearer wrong', 'secret'), false);
		assert.equal(bearerMatches('Bearer ', 'secret'), false);
		assert.equal(bearerMatches('Bearer secret', ''), false);
	});
});

describe('browser request origin policy', () => {
	it('accepts missing Origin and same-origin loopback HTTP', () => {
		assert.equal(browserRequestAllowed(undefined, 'localhost:8080'), true);
		assert.equal(browserRequestAllowed('http://localhost:8080', 'localhost:8080'), true);
		assert.equal(browserRequestAllowed('http://127.0.0.1:8080', '127.0.0.1:8080'), true);
		assert.equal(browserRequestAllowed('http://192.168.1.5:8080', '192.168.1.5:8080'), true);
	});

	it('rejects cross-origin requests and plain-HTTP DNS rebinding', () => {
		assert.equal(browserRequestAllowed('https://evil.example', 'localhost:8080'), false);
		assert.equal(browserRequestAllowed('http://evil.example:8080', 'evil.example:8080'), false);
		assert.equal(browserRequestAllowed('http://localhost:8080', 'evil.example:8080'), false);
	});

	it('allows an HTTPS reverse proxy with matching authority', () => {
		assert.equal(browserRequestAllowed('https://core.example', 'core.example'), true);
	});

	it('recognizes only loopback origins and subdomains', () => {
		for (const origin of ['http://localhost', 'http://127.0.0.1:80', 'http://[::1]:80', 'http://ui.localhost']) {
			assert.equal(isLoopbackOrigin(origin), true, origin);
		}
		for (const origin of ['https://localhost.evil.example', 'not an origin']) {
			assert.equal(isLoopbackOrigin(origin), false, origin);
		}
	});

	it('restricts bearer routes to direct same-origin loopback requests', () => {
		const allowed = directLoopbackBearerRouteAllowed(
			'127.0.0.1', 'localhost:8080', 'http://localhost:8080', { host: 'localhost:8080' },
		);
		assert.equal(allowed, true);
		for (const headers of [
			{ host: 'localhost:8080', 'cf-connecting-ip': '198.51.100.4' },
			{ host: 'localhost:8080', 'x-original-forwarded-for': '198.51.100.4' },
		]) {
			assert.equal(directLoopbackBearerRouteAllowed(
				'127.0.0.1', 'localhost:8080', 'http://localhost:8080', headers,
			), false);
		}
		assert.equal(directLoopbackBearerRouteAllowed(
			'127.0.0.1', 'localhost:8080', undefined, { host: 'localhost:8080' },
		), false);
		assert.equal(directLoopbackBearerRouteAllowed(
			'127.0.0.1', 'localhost:8080', 'http://127.0.0.1:9999', { host: 'localhost:8080' },
		), false);
		assert.equal(directLoopbackBearerRouteAllowed(
			'203.0.113.5', 'localhost:8080', 'http://localhost:8080', { host: 'localhost:8080' },
		), false);
	});
});
