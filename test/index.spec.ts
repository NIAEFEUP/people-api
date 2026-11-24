import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

interface MockMember {
	email?: string;
	type?: string;
	status?: string;
}

interface MockUser {
	primaryEmail?: string;
	emails?: Array<{ address?: string }>;
	aliases?: string[];
	nonEditableAliases?: string[];
	name?: { givenName?: string; familyName?: string };
	thumbnailPhotoUrl?: string;
}

type FetchRouteHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function setupFetchMock(routes: Array<{ match: (url: URL, init?: RequestInit) => boolean; handle: FetchRouteHandler }>) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
		for (const route of routes) {
			if (route.match(url, init)) {
				return route.handle(url, init);
			}
		}
		throw new Error(`Unexpected fetch call to ${url.toString()}`);
	});
}

function oauthRoute(accessToken = 'mock-access-token') {
	return {
		match: (url: URL, init?: RequestInit) => url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token' && init?.method === 'POST',
		handle: () => Response.json({ access_token: accessToken }),
	};
}

function groupMembersRoute(groupEmail: string, pages: Record<string, { members?: MockMember[]; nextPageToken?: string }>) {
	const expectedPath = `/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`;
	return {
		match: (url: URL) => url.origin === 'https://admin.googleapis.com' && url.pathname === expectedPath,
		handle: (url: URL) => {
			const token = url.searchParams.get('pageToken') ?? '';
			const page = pages[token];
			if (!page) {
				throw new Error(`Unexpected group members pageToken: "${token}"`);
			}
			return Response.json(page);
		},
	};
}

function usersRoute(pages: Record<string, { users?: MockUser[]; nextPageToken?: string }>) {
	return {
		match: (url: URL) => url.origin === 'https://admin.googleapis.com' && url.pathname === '/admin/directory/v1/users',
		handle: (url: URL) => {
			const token = url.searchParams.get('pageToken') ?? '';
			const page = pages[token];
			if (!page) {
				throw new Error(`Unexpected users pageToken: "${token}"`);
			}
			return Response.json(page);
		},
	};
}

async function callWorker(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe('people-api worker', () => {
	beforeEach(async () => {
		const keys = await env.NIFEUP_MEMBERS_CACHE.list();
		await Promise.all(keys.keys.map((k) => env.NIFEUP_MEMBERS_CACHE.delete(k.name)));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('CORS and HTTP methods', () => {
		it('handles OPTIONS preflight requests with CORS headers', async () => {
			const response = await SELF.fetch('https://example.com/recruits', { method: 'OPTIONS' });

			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
			expect(await response.text()).toBe('');
		});

		it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('rejects %s requests with 405 Method Not Allowed', async (method) => {
			const response = await callWorker('/recruits', { method });

			expect(response.status).toBe(405);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(await response.text()).toBe('Method Not Allowed');
		});
	});

	describe('Routing', () => {
		it('returns 404 with available endpoints for unknown paths', async () => {
			const response = await SELF.fetch('https://example.com/unknown');

			expect(response.status).toBe(404);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(await response.json()).toEqual({
				error: 'Not Found',
				availableEndpoints: ['/recruits', '/active-members', '/fiscal-council', '/general-assembly', '/board'],
			});
		});

		it.each([
			['/recruits', 'recruits', 'recrutas@nifeup.com'],
			['/active-members', 'active-members', 'membros@nifeup.com'],
			['/fiscal-council', 'fiscal-council', 'cf@nifeup.com'],
			['/general-assembly', 'general-assembly', 'mag@nifeup.com'],
			['/board', 'board', 'direcao@nifeup.com'],
		])('maps %s to group %s', async (path, expectedGroup, groupEmail) => {
			setupFetchMock([
				oauthRoute(),
				groupMembersRoute(groupEmail, {
					'': { members: [{ email: 'alice@nifeup.com', type: 'USER', status: 'ACTIVE' }] },
				}),
				usersRoute({
					'': {
						users: [{ primaryEmail: 'alice@nifeup.com', name: { givenName: 'Alice', familyName: 'Silva' } }],
					},
				}),
			]);

			const response = await callWorker(path);
			expect(response.status).toBe(200);

			const body = (await response.json()) as {
				group: string;
				count: number;
				updatedAt: string;
				members: Array<{ firstName: string; lastName: string; photoUrl: string | null }>;
			};
			expect(body.group).toBe(expectedGroup);
			expect(body.count).toBe(1);
			expect(body.members).toEqual([{ firstName: 'Alice', lastName: 'Silva', photoUrl: null }]);
		});
	});

	describe('KV Caching', () => {
		it('returns cached response with X-Cache: HIT without calling Google APIs', async () => {
			const cachedPayload = JSON.stringify({
				group: 'recruits',
				count: 1,
				updatedAt: '2026-01-01T00:00:00.000Z',
				members: [{ firstName: 'Cached', lastName: 'User', photoUrl: null }],
			});
			await env.NIFEUP_MEMBERS_CACHE.put('group:recruits', cachedPayload);
			const fetchSpy = setupFetchMock([]);

			const response = await callWorker('/recruits');

			expect(response.status).toBe(200);
			expect(response.headers.get('X-Cache')).toBe('HIT');
			expect(response.headers.get('Content-Type')).toBe('application/json');
			expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(await response.text()).toBe(cachedPayload);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('stores fresh response in KV on cache MISS', async () => {
			setupFetchMock([
				oauthRoute(),
				groupMembersRoute('direcao@nifeup.com', {
					'': { members: [{ email: 'bob@nifeup.com', type: 'USER', status: 'ACTIVE' }] },
				}),
				usersRoute({
					'': {
						users: [
							{
								primaryEmail: 'bob@nifeup.com',
								name: { givenName: 'Bob', familyName: 'Costa' },
								thumbnailPhotoUrl: 'https://lh3.googleusercontent.com/a/avatar=s96-c',
							},
						],
					},
				}),
			]);

			const response = await callWorker('/board');

			expect(response.status).toBe(200);
			expect(response.headers.get('X-Cache')).toBe('MISS');
			expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');

			const body = (await response.json()) as {
				group: string;
				count: number;
				updatedAt: string;
				members: Array<{ firstName: string; lastName: string; photoUrl: string | null }>;
			};
			expect(body.group).toBe('board');
			expect(body.count).toBe(1);
			expect(Date.parse(body.updatedAt)).not.toBeNaN();
			expect(body.members).toEqual([
				{
					firstName: 'Bob',
					lastName: 'Costa',
					photoUrl: 'https://lh3.googleusercontent.com/a/avatar=s512-c',
				},
			]);

			const stored = await env.NIFEUP_MEMBERS_CACHE.get('group:board');
			expect(stored).toBe(JSON.stringify(body));
		});

		it('bypasses cache and updates KV when refresh=true', async () => {
			await env.NIFEUP_MEMBERS_CACHE.put(
				'group:board',
				JSON.stringify({
					group: 'board',
					count: 0,
					updatedAt: '2026-01-01T00:00:00.000Z',
					members: [],
				})
			);

			setupFetchMock([
				oauthRoute(),
				groupMembersRoute('direcao@nifeup.com', {
					'': { members: [{ email: 'carol@nifeup.com', type: 'USER', status: 'ACTIVE' }] },
				}),
				usersRoute({
					'': {
						users: [{ primaryEmail: 'carol@nifeup.com', name: { givenName: 'Carol', familyName: 'Dias' } }],
					},
				}),
			]);

			const response = await callWorker('/board?refresh=true');

			expect(response.status).toBe(200);
			expect(response.headers.get('X-Cache')).toBe('MISS');
			const body = (await response.json()) as { count: number; members: Array<{ firstName: string }> };
			expect(body.count).toBe(1);
			expect(body.members[0].firstName).toBe('Carol');

			const stored = await env.NIFEUP_MEMBERS_CACHE.get('group:board');
			expect(stored).toContain('Carol');
		});
	});

	describe('Google Directory filtering, aliases, photos, and pagination', () => {
		it('filters inactive/non-user/ignored members, matches aliases, formats photos, and paginates', async () => {
			setupFetchMock([
				oauthRoute(),
				groupMembersRoute('membros@nifeup.com', {
					'': {
						members: [
							{ email: 'subgroup@nifeup.com', type: 'GROUP', status: 'ACTIVE' },
							{ email: 'suspended@nifeup.com', type: 'USER', status: 'SUSPENDED' },
							{ email: 'SYSADMIN@nifeup.com', type: 'USER', status: 'ACTIVE' },
							{ email: 'ALIAS@nifeup.com', type: 'USER', status: 'ACTIVE' },
						],
						nextPageToken: 'member-page-2',
					},
					'member-page-2': {
						members: [{ email: 'noneditable@nifeup.com', type: 'USER', status: 'ACTIVE' }],
					},
				}),
				usersRoute({
					'': {
						users: [
							{
								primaryEmail: 'other@nifeup.com',
								aliases: ['alias@nifeup.com'],
								name: { givenName: 'Alias', familyName: 'Member' },
								thumbnailPhotoUrl: 'https://lh3.googleusercontent.com/a/photo/s96/img.jpg',
							},
							{
								primaryEmail: 'sysadmin-real@nifeup.com',
								aliases: ['sysadmin@nifeup.com'],
								name: { givenName: 'Sys', familyName: 'Admin' },
							},
						],
						nextPageToken: 'user-page-2',
					},
					'user-page-2': {
						users: [
							{
								primaryEmail: 'second@nifeup.com',
								nonEditableAliases: ['noneditable@nifeup.com'],
								name: { givenName: 'Second' },
							},
							{
								primaryEmail: 'unrelated@nifeup.com',
								name: { givenName: 'Unrelated', familyName: 'Person' },
							},
						],
					},
				}),
			]);

			const response = await callWorker('/active-members');
			expect(response.status).toBe(200);

			const body = (await response.json()) as {
				count: number;
				members: Array<{ firstName: string; lastName: string; photoUrl: string | null }>;
			};
			expect(body.count).toBe(2);
			expect(body.members).toEqual([
				{
					firstName: 'Alias',
					lastName: 'Member',
					photoUrl: 'https://lh3.googleusercontent.com/a/photo/s512-c/img.jpg',
				},
				{
					firstName: 'Second',
					lastName: '',
					photoUrl: null,
				},
			]);
		});

		it('returns empty members without calling Users API when group has no eligible members', async () => {
			const fetchSpy = setupFetchMock([
				oauthRoute(),
				groupMembersRoute('cf@nifeup.com', {
					'': { members: [{ email: 'sysadmin@nifeup.com', type: 'USER', status: 'ACTIVE' }] },
				}),
			]);

			const response = await callWorker('/fiscal-council');
			expect(response.status).toBe(200);

			const body = (await response.json()) as { group: string; count: number; members: unknown[] };
			expect(body.group).toBe('fiscal-council');
			expect(body.count).toBe(0);
			expect(body.members).toEqual([]);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe('Error handling', () => {
		it('returns 500 when OAuth token refresh fails', async () => {
			setupFetchMock([
				{
					match: (url) => url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token',
					handle: () => new Response('invalid_client', { status: 401 }),
				},
			]);

			const response = await callWorker('/recruits');

			expect(response.status).toBe(500);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(await response.json()).toEqual({
				error: 'Failed to fetch group members',
				details: 'OAuth token refresh failed: invalid_client',
			});
		});

		it('returns 500 when Groups Members API fails', async () => {
			setupFetchMock([
				oauthRoute(),
				{
					match: (url) => url.origin === 'https://admin.googleapis.com' && url.pathname.includes('/groups/'),
					handle: () => new Response('forbidden', { status: 403 }),
				},
			]);

			const response = await callWorker('/recruits');

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: 'Failed to fetch group members',
				details: 'Groups Members API error: forbidden',
			});
		});

		it('returns 500 when Users API fails', async () => {
			setupFetchMock([
				oauthRoute(),
				groupMembersRoute('recrutas@nifeup.com', {
					'': { members: [{ email: 'alice@nifeup.com', type: 'USER', status: 'ACTIVE' }] },
				}),
				{
					match: (url) => url.origin === 'https://admin.googleapis.com' && url.pathname === '/admin/directory/v1/users',
					handle: () => new Response('users_api_down', { status: 500 }),
				},
			]);

			const response = await callWorker('/recruits');

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: 'Failed to fetch group members',
				details: 'Users API error: users_api_down',
			});
		});
	});
});
