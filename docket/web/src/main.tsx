import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initToken } from './api';
import { App } from './App';
import './styles.css';

// Before the first render: a one-time #token= or ?token= is saved and removed from the URL.
initToken();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
}
