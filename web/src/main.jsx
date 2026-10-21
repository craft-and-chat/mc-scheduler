import { render } from 'preact';
import { captureAccessCode } from './api.js';
import { App } from './App.jsx';
import './styles.css';

captureAccessCode();
render(<App />, document.getElementById('app'));
