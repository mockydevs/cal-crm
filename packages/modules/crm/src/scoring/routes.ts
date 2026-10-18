// Engagement scoring as the API serves it: Settings → Manage Scoring, and a contact's score.
import type { ApiRoute } from '@repo/commands';

import { scoreProfileRoutes } from './profile.js';
import { contactScoreRoutes } from './scores.js';

export const scoringRoutes: readonly ApiRoute[] = [...scoreProfileRoutes, ...contactScoreRoutes];
