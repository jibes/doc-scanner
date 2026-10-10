import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { startUpdates } from './lib/update.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app mount point is missing from index.html');

startUpdates();

export default mount(App, { target });
