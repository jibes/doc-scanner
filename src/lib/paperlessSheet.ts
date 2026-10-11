import { mount, unmount } from 'svelte';
import PaperlessSheet from '../components/PaperlessSheet.svelte';
import type { UploadSelection } from './paperlessMeta';
import type { PaperlessSettings } from './settings';

/**
 * Ask which tags, document type and correspondent to file a document under,
 * prefilled with the defaults from the settings. Resolves with the choice, or
 * null when the user cancels.
 */
export function pickUploadMeta(
  config: PaperlessSettings,
  title: string,
  options: { initial?: UploadSelection; confirmLabel?: string } = {},
): Promise<UploadSelection | null> {
  return new Promise((resolve) => {
    const target = document.createElement('div');
    document.body.append(target);
    const finish = (selection: UploadSelection | null) => {
      resolve(selection);
      // After the current event: the sheet is still handling it.
      setTimeout(() => {
        void unmount(sheet);
        target.remove();
      });
    };
    const sheet = mount(PaperlessSheet, {
      target,
      props: {
        config,
        title,
        initial: options.initial,
        confirmLabel: options.confirmLabel,
        onConfirm: (selection: UploadSelection) => finish(selection),
        onCancel: () => finish(null),
      },
    });
  });
}
