import { expect, it } from 'vitest';

import { createTemplateFolderRoutes } from './template-folder-routes.js';

it('registers each folder and placement route with its required mutation permission', () => {
  expect(
    createTemplateFolderRoutes().map((route) => [
      route.endpoint.operationId,
      route.command?.name,
      route.command?.permission,
    ]),
  ).toEqual([
    ['listMessageTemplateFolders', undefined, undefined],
    ['getMessageTemplateFolder', undefined, undefined],
    ['createMessageTemplateFolder', 'template.create_folder', 'templates.manage'],
    ['updateMessageTemplateFolder', 'template.update_folder', 'templates.manage'],
    ['removeMessageTemplateFolder', 'template.remove_folder', 'templates.manage'],
    ['moveMessageTemplate', 'template.move', 'templates.manage'],
  ]);
});
