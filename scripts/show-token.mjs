import { loadPairingToken } from '../server/index.mjs';

// Deliberately local and interactive: never sent to the browser page or provider.
const {token} = await loadPairingToken();
console.log('انسخ هذا الرمز إلى إعدادات الإضافة على جهازك فقط:');
console.log(token);
