// The media library's API routes. The public and preview addresses aren't among them:
// nobody signs in to open one, so the server serves them itself (public-media.ts).
import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createMediaFolder,
  deleteMedia,
  getMediaFile,
  getMediaUsage,
  listMedia,
  listMediaFolders,
  moveMedia,
  parseInput,
  removeMediaFolder,
  updateMediaFile,
  updateMediaFolder,
} from '@repo/contracts';

import type { Media } from './media.js';

export function mediaRoutes(media: Media): readonly ApiRoute[] {
  const { commands, folders } = media;
  const list = {
    endpoint: listMedia,
    run: ({ invocation, query }, services) =>
      media.list(services, invocation, parseInput(listMedia.query, query)),
  } satisfies Route<typeof listMedia>;
  const usage = {
    endpoint: getMediaUsage,
    run: ({ invocation }, services) => media.usage(services, invocation),
  } satisfies Route<typeof getMediaUsage>;
  const read = {
    endpoint: getMediaFile,
    run({ invocation, params }, services) {
      const { id } = parseInput(getMediaFile.params, params);
      return media.read(services, invocation, id);
    },
  } satisfies Route<typeof getMediaFile>;
  const update = {
    endpoint: updateMediaFile,
    command: commands.update,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(updateMediaFile.params, params);
      return runCommand(
        services,
        commands.update,
        { ...parseInput(updateMediaFile.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof updateMediaFile>;
  const move = {
    endpoint: moveMedia,
    command: commands.move,
    run: ({ invocation, body }, services) => runCommand(services, commands.move, body, invocation),
  } satisfies Route<typeof moveMedia>;
  const remove = {
    endpoint: deleteMedia,
    command: commands.remove,
    run: ({ invocation, body }, services) =>
      runCommand(services, commands.remove, body, invocation),
  } satisfies Route<typeof deleteMedia>;
  const folderList = {
    endpoint: listMediaFolders,
    run: ({ invocation }, services) => media.folderList(services, invocation),
  } satisfies Route<typeof listMediaFolders>;
  const createFolder = {
    endpoint: createMediaFolder,
    command: folders.create,
    run: ({ invocation, body }, services) => runCommand(services, folders.create, body, invocation),
  } satisfies Route<typeof createMediaFolder>;
  const updateFolder = {
    endpoint: updateMediaFolder,
    command: folders.update,
    run({ invocation, params, body }, services) {
      const { id } = parseInput(updateMediaFolder.params, params);
      return runCommand(
        services,
        folders.update,
        { ...parseInput(updateMediaFolder.body, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof updateMediaFolder>;
  const removeFolder = {
    endpoint: removeMediaFolder,
    command: folders.remove,
    run({ invocation, params }, services) {
      const { id } = parseInput(removeMediaFolder.params, params);
      return runCommand(services, folders.remove, { id }, invocation);
    },
  } satisfies Route<typeof removeMediaFolder>;
  return [
    list,
    usage,
    read,
    update,
    move,
    remove,
    folderList,
    createFolder,
    updateFolder,
    removeFolder,
  ];
}
