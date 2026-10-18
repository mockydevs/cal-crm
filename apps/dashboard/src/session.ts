// The agency the sign-in pages show. They come before anyone is signed in, so they can't
// ask GET /me (workspace.ts); they show a default agency until branding
// gives each install its own name.

export const signInAgency = { name: 'Bluebird Digital' } as const;
