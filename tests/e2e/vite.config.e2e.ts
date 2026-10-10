/**
 * The app's Vite config for the e2e harness: HMR off, so source edits made
 * while a long run is in progress do not reload the harness page mid-case.
 * Changes are still picked up by the next case's fresh page load.
 */
import { mergeConfig } from 'vite';
import base from '../../vite.config';

export default mergeConfig(base, { server: { hmr: false } });
