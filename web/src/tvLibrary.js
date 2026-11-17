// TradingView's licensed Advanced Charts library, when the server has it
// (web/assets/tradingview/, served at /tradingview/): loaded once on demand;
// true when window.TradingView.widget is there to draw with.
import { api } from './api';
import { url } from './base';

let loading = null;
export function loadTvLibrary() {
  loading ??= api
    .quotesStatus()
    .then((q) => {
      if (!q?.tvLibrary || window.TradingView?.widget) return;
      return new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = url('/tradingview/charting_library/charting_library.standalone.js');
        s.onload = resolve;
        s.onerror = resolve;
        document.head.appendChild(s);
      });
    })
    .catch(() => {})
    .then(() => !!window.TradingView?.widget);
  return loading;
}
