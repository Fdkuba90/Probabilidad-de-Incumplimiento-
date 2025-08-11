# App PI Buró – Pasos rápidos

1) **Instala dependencias**
```
npm i
```

2) **Corre en desarrollo**
```
npm run dev
```

3) Abre `http://localhost:3000` y carga un **PDF del Buró Empresarial**.

4) Si no detecta "Califica": ajusta `lib/parseCalifica.js` (HEADERS y parsing).

### Errores comunes
- **415/400**: Asegúrate de enviar `FormData` con el campo `file`.
- **Cannot find module 'formidable' / 'pdf-parse'**: Falta `npm i`.
- **bodyParser**: Debe estar desactivado en el API (ver `export const config` en `pages/api/analyzePdf.js`).
- **Runtime Edge**: No usar runtime Edge en este endpoint; usar Node (pages/api estándar).