import { mount } from 'svelte';
import '../../styles/workspace.css';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
