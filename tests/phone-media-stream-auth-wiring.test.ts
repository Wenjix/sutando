import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../skills/phone-conversation/scripts/conversation-server.ts', import.meta.url), 'utf8');

test('phone media streams and call controls use authenticated per-call state', () => {
	assert.match(SOURCE, /new WebSocketServer\(\{[\s\S]*?verifyClient:\s*\(info(?::\s*\{[^}]*\})?\s*\)\s*=>\s*\{[\s\S]*?isValidMediaStreamUpgrade\(TWILIO_AUTH_TOKEN,\s*info\.req\.headers,\s*WEBHOOK_BASE_URL\)/);
	assert.match(SOURCE, /callRecords\.claim\(msg\.start\.callSid\)/);
	assert.doesNotMatch(SOURCE, /cp\.(?:purpose|to|callerNumber|stirVerstat|parentCallSid)\b/);
	assert.match(SOURCE, /isTwilioPath\s*&&\s*!isValidTwilioSignature\(/);
	assert.match(SOURCE, /!isDirectLoopback\(req\)/);
	assert.match(SOURCE, /if\s*\(callSession\.isOwner\)\s*\{\s*await attachVisionToCall\(session\);/);
	assert.match(SOURCE, /playbackOwner\.controlledBy\(callSession\.callSid\)/);
});
