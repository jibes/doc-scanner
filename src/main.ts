import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { startInstall } from './lib/onboarding.svelte';
import { startUpdates } from './lib/update.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app mount point is missing from index.html');

startUpdates();
startInstall();

export default mount(App, { target });
