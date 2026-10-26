import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import {
	mediaStreamStartMatches,
	readTwilioBody,
	twilioWebhookDecision,
} from '../skills/phone-conversation/scripts/twilio_request_auth.js';

const TOKEN = 'test-auth-token';
const SOURCE = readFileSync(new URL('../skills/phone-conversation/scripts/conversation-server.ts', import.meta.url), 'utf8');

function sign(url: string, params: URLSearchParams): string {
	let signed = url;
	for (const key of [...new Set(params.keys())].sort()) {
		for (const value of params.getAll(key).sort()) signed += key + value;
	}
	return createHmac('sha1', TOKEN).update(signed).digest('base64');
}

test('phone request handlers delegate HTTP and upgrade authorization to the adapter', () => {
	assert.match(
		SOURCE,
		/readTwilioBody\(req\)[\s\S]*?twilioWebhookDecision\([\s\S]*?isValidMediaStreamUpgrade\([\s\S]*?info\.req\.url/,
	);
	assert.match(SOURCE, /ownerVisionBinding\.attach\(params\.callSid, session\)[\s\S]*?ownerVisionBinding\.remove\(callSid\)/);
	assert.match(SOURCE, /ffmpegProc\.on\('close'[\s\S]*?clearActivePlaybackProcess\(activePlaybackProc, ffmpegProc\)/);
});

test('HTTP Twilio gate accepts signed requests and rejects unsigned or changed bodies', () => {
	const url = 'https://phone.example/twilio/connect';
	const body = 'CallSid=CA123&From=%2B14155550100';
	const signature = sign(url, new URLSearchParams(body));
	assert.deepEqual(twilioWebhookDecision(TOKEN, signature, url, body), { ok: true });
	assert.deepEqual(twilioWebhookDecision(TOKEN, undefined, url, body), {
		ok: false, status: 403, error: 'invalid Twilio signature',
	});
	assert.deepEqual(twilioWebhookDecision(TOKEN, signature, url, `${body}&To=other`), {
		ok: false, status: 403, error: 'invalid Twilio signature',
	});
});

test('HTTP Twilio gate returns 413 before checking a body signature', () => {
	assert.deepEqual(twilioWebhookDecision(TOKEN, undefined, 'https://phone.example/twilio/connect', '', true), {
		ok: false, status: 413, error: 'Twilio request body exceeds 64 KiB',
	});
});

test('a media stream start must match the CallSid bound to its signed URL', () => {
	assert.equal(mediaStreamStartMatches('CA123', 'CA123'), true);
	assert.equal(mediaStreamStartMatches('CA123', 'CA999'), false);
	assert.equal(mediaStreamStartMatches(null, 'CA123'), false);
});

test('oversized Twilio bodies are paused before their contents can be checked', async () => {
	const req = new PassThrough() as unknown as IncomingMessage;
	(req as unknown as { headers: Record<string, string> }).headers = {};
	const bodyRead = readTwilioBody(req);
	(req as unknown as PassThrough).write(Buffer.alloc(64 * 1024 + 1));
	const result = await bodyRead;
	assert.deepEqual(result, { body: '', tooLarge: true });
	assert.equal((req as unknown as PassThrough).isPaused(), true);
});
