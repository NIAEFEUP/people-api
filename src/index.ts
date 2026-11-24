export interface Env {
	NIFEUP_MEMBERS_CACHE: KVNamespace;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	GOOGLE_REFRESH_TOKEN: string;
	GROUP_RECRUITS: string;
	GROUP_ACTIVE: string;
	GROUP_FISCAL: string;
	GROUP_ASSEMBLY: string;
	GROUP_BOARD: string;
}

interface MemberProfile {
	firstName: string;
	lastName: string;
	photoUrl: string | null;
}

const CACHE_TTL_SECONDS = 3600;

const IGNORED_EMAILS = new Set(['sysadmin@nifeup.com']);

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		if (request.method !== 'GET') {
			return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
		}

		const url = new URL(request.url);
		const routeMap: Record<string, string> = {
			'/recruits': env.GROUP_RECRUITS,
			'/active-members': env.GROUP_ACTIVE,
			'/fiscal-council': env.GROUP_FISCAL,
			'/general-assembly': env.GROUP_ASSEMBLY,
			'/board': env.GROUP_BOARD,
		};

		const groupEmail = routeMap[url.pathname];
		if (!groupEmail) {
			return Response.json(
				{ error: 'Not Found', availableEndpoints: Object.keys(routeMap) },
				{ status: 404, headers: corsHeaders }
			);
		}

		const cacheKey = `group:${url.pathname.slice(1)}`;
		const forceRefresh = url.searchParams.get('refresh') === 'true';

		if (!forceRefresh) {
			const cachedJson = await env.NIFEUP_MEMBERS_CACHE.get(cacheKey);
			if (cachedJson) {
				return new Response(cachedJson, {
					headers: {
						...corsHeaders,
						'Content-Type': 'application/json',
						'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
						'X-Cache': 'HIT',
					},
				});
			}
		}

		try {
			const accessToken = await getGoogleAccessToken(env);
			const members = await fetchGroupMembersBulk(groupEmail, accessToken);

			const payload = JSON.stringify({
				group: url.pathname.slice(1),
				count: members.length,
				updatedAt: new Date().toISOString(),
				members,
			});

			await env.NIFEUP_MEMBERS_CACHE.put(cacheKey, payload, {
				expirationTtl: CACHE_TTL_SECONDS,
			});

			return new Response(payload, {
				headers: {
					...corsHeaders,
					'Content-Type': 'application/json',
					'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
					'X-Cache': 'MISS',
				},
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			return Response.json(
				{ error: 'Failed to fetch group members', details: message },
				{ status: 500, headers: corsHeaders }
			);
		}
	},
};

async function getGoogleAccessToken(env: Env): Promise<string> {
	const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: env.GOOGLE_REFRESH_TOKEN,
			grant_type: 'refresh_token',
		}),
	});

	if (!tokenRes.ok) {
		throw new Error(`OAuth token refresh failed: ${await tokenRes.text()}`);
	}

	const data: { access_token: string } = await tokenRes.json();
	return data.access_token;
}

function getHighResPhotoUrl(thumbnailUrl?: string, size = 512): string | null {
	if (!thumbnailUrl) return null;

	return thumbnailUrl.replace(/([=/])s\d+(-c)?/, `$1s${size}-c`);
}

async function fetchGroupMembersBulk(
	groupEmail: string,
	accessToken: string
): Promise<MemberProfile[]> {
	const memberEmails = new Set<string>();
	let memberPageToken: string | undefined;

	do {
		const membersUrl = new URL(
			`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`
		);
		membersUrl.searchParams.set('roles', 'OWNER,MANAGER,MEMBER');
		membersUrl.searchParams.set('includeDerivedMembership', 'true');
		membersUrl.searchParams.set('maxResults', '200');
		if (memberPageToken) membersUrl.searchParams.set('pageToken', memberPageToken);

		const listRes = await fetch(membersUrl.toString(), {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!listRes.ok) {
			throw new Error(`Groups Members API error: ${await listRes.text()}`);
		}

		const listData: {
			members?: Array<{ email?: string; type?: string; status?: string }>;
			nextPageToken?: string;
		} = await listRes.json();

		for (const m of listData.members || []) {
			const email = m.email?.toLowerCase();
			if (m.type === 'USER' && m.status === 'ACTIVE' && email && !IGNORED_EMAILS.has(email)) {
				memberEmails.add(email);
			}
		}
		memberPageToken = listData.nextPageToken;
	} while (memberPageToken);

	if (memberEmails.size === 0) return [];

	const profiles: MemberProfile[] = [];
	let userPageToken: string | undefined;

	do {
		const usersUrl = new URL('https://admin.googleapis.com/admin/directory/v1/users');
		usersUrl.searchParams.set('customer', 'my_customer');
		usersUrl.searchParams.set('maxResults', '500');
		usersUrl.searchParams.set('viewType', 'admin_view');
		usersUrl.searchParams.set(
			'fields',
			'nextPageToken,users(primaryEmail,emails,aliases,nonEditableAliases,name(givenName,familyName),thumbnailPhotoUrl)'
		);
		if (userPageToken) usersUrl.searchParams.set('pageToken', userPageToken);

		const usersRes = await fetch(usersUrl.toString(), {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!usersRes.ok) {
			throw new Error(`Users API error: ${await usersRes.text()}`);
		}

		const usersData: {
			users?: Array<{
				primaryEmail?: string;
				emails?: Array<{ address?: string }>;
				aliases?: string[];
				nonEditableAliases?: string[];
				name?: { givenName?: string; familyName?: string };
				thumbnailPhotoUrl?: string;
			}>;
			nextPageToken?: string;
		} = await usersRes.json();

		for (const u of usersData.users || []) {
			const allUserEmails = [
				u.primaryEmail,
				...(u.emails?.map((e) => e.address) || []),
				...(u.aliases || []),
				...(u.nonEditableAliases || []),
			]
				.filter((e): e is string => Boolean(e))
				.map((e) => e.toLowerCase());

			if (allUserEmails.some((email) => IGNORED_EMAILS.has(email))) {
				continue;
			}

			if (allUserEmails.some((email) => memberEmails.has(email))) {
				profiles.push({
					firstName: u.name?.givenName || '',
					lastName: u.name?.familyName || '',
					photoUrl: getHighResPhotoUrl(u.thumbnailPhotoUrl),
				});
			}
		}

		userPageToken = usersData.nextPageToken;
	} while (userPageToken);

	return profiles;
}