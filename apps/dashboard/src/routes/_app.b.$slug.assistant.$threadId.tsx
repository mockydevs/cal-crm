import { createFileRoute } from '@tanstack/react-router';

// One conversation with the assistant, by its id. The page is its parent's (assistant.tsx),
// which reads the id from the address; nothing is drawn here.
export const Route = createFileRoute('/_app/b/$slug/assistant/$threadId')({});
