import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { CallRecordStore } from '../skills/phone-conversation/scripts/call_records.js';
import {
	mediaStreamClaim,
	mediaStreamVerifyClient,
} from '../skills/phone-conversation/scripts/media_stream_binding.js';

const TOKEN = 'test-auth-token';
const BASE = 'https://phone.example';
const STREAM_URL = 'wss://phone.example/media-stream';

function sign(url: string, params: URLSearchParams = new URLSearchParams()): string {
	let signed = url;
	for (const key of [...new Set(params.keys())].sort()) {
		for (const value of params.getAll(key).sort()) signed += key + value;
	}
	return createHmac('sha1', TOKEN).update(signed).digest('base64');
}

function upgradeInfo(headers: Record<string, string>, remote = '10.0.0.9') {
	return {
		origin: 'https://phone.example',
		secure: true,
		req: {
			headers,
			socket: { remoteAddress: remote },
		} as unknown as IncomingMessage,
	};
}

test('the installed upgrade gate refuses an unsigned media-stream upgrade', () => {
	const rejected: string[] = [];
	const verify = mediaStreamVerifyClient(TOKEN, BASE, (remote) => rejected.push(remote));
	assert.equal(verify(upgradeInfo({})), false);
	assert.equal(verify(upgradeInfo({ 'x-twilio-signature': 'forged' })), false);
	assert.deepEqual(rejected, ['10.0.0.9', '10.0.0.9']);
});

test('the installed upgrade gate accepts an upgrade signed over the bare stream URL', () => {
	const verify = mediaStreamVerifyClient(TOKEN, BASE);
	assert.equal(verify(upgradeInfo({ 'x-twilio-signature': sign(STREAM_URL) })), true);
	// A signature over a query-laden URL (the old transport) must not pass.
	const queryUrl = `${STREAM_URL}?callSid=CA123`;
	assert.equal(verify(upgradeInfo({ 'x-twilio-signature': sign(queryUrl) })), false);
});

test('the installed start gate binds and claims exactly once', () => {
	const records = new CallRecordStore();
	records.put({
		callSid: 'CA123', callerNumber: '+14155550100', recipientNumber: '+14155550200',
		stirVerstat: 'TN-Validation-Passed-A', purpose: 'inbound', isMeeting: false,
		meetingId: '', passcode: '', parentCallSid: '',
	});

	const start = { callSid: 'CA123', customParameters: { callSid: 'CA123' } };
	const claimed = mediaStreamClaim(records, start);
	assert.deepEqual(claimed.ok ? { ok: true, callSid: claimed.callSid } : claimed, {
		ok: true, callSid: 'CA123',
	});
	// The claim is one-shot: a replayed start for the same call finds nothing.
	assert.deepEqual(mediaStreamClaim(records, start), { ok: false, reason: 'unknown call' });
});

test('the installed start gate refuses a frame whose two CallSids disagree', () => {
	const records = new CallRecordStore();
	records.put({
		callSid: 'CA123', callerNumber: '', recipientNumber: '',
		stirVerstat: '', purpose: '', isMeeting: false,
		meetingId: '', passcode: '', parentCallSid: '',
	});
	assert.deepEqual(
		mediaStreamClaim(records, { callSid: 'CA123', customParameters: { callSid: 'CA999' } }),
		{ ok: false, reason: 'callSid mismatch' },
	);
	// The stored record is untouched — a mismatch must not burn another call's claim.
	assert.equal(mediaStreamClaim(records, { callSid: 'CA123', customParameters: { callSid: 'CA123' } }).ok, true);
});

test('the installed start gate refuses a call that never connected', () => {
	const records = new CallRecordStore();
	assert.deepEqual(
		mediaStreamClaim(records, { callSid: 'CA999', customParameters: { callSid: 'CA999' } }),
		{ ok: false, reason: 'unknown call' },
	);
});
