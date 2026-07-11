import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import App from "./App.vue";
import QuickSearchWindow from './QuickSearchWindow.vue';
import "./styles/theme.css";
import "virtual:uno.css";
import i18n from "./i18n";

// Disable right-click context menu
if (import.meta.env.PROD) {
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
}

const isQuickSearchWindow = new URLSearchParams(window.location.search).get('window') === 'quick-search';
const app = createApp(isQuickSearchWindow ? QuickSearchWindow : App);
app.use(createPinia());
app.use(ElementPlus);
app.use(i18n);
app.mount("#app");
