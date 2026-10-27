# Advent of Kudos 🎄

Calendario de adviento para el equipo. Cada día se abre una ventana con una persona del equipo y el resto le deja **kudos**. A medianoche su foto se convierte en una bola del árbol de Navidad; al pulsarla se leen todos sus kudos.

- **Web:** `public/index.html` (HTML, CSS y JS sin dependencias).
- **API:** `functions/api/[[path]].js` (Cloudflare Pages Functions).
- **Base de datos:** Cloudflare D1. Las tablas se crean solas en la primera petición.

## Cómo funciona

- El organizador entra con una contraseña (`ADMIN_PASSWORD`), añade al equipo (nombre, rol y foto), elige el primer día y la zona horaria.
- Cada persona ocupa un día laborable, en el orden del panel. Los sábados y domingos no sale nadie.
- Solo se pueden enviar kudos a la persona del día. Cada navegador puede dejar uno por persona y editarlo o retirarlo hasta medianoche.
- Los mensajes se mantienen ocultos hasta medianoche: el servidor solo los envía cuando su día ha terminado (el organizador los ve siempre).
- La página se actualiza sola cada 30 segundos.

## Puesta en marcha en Cloudflare

1. **Base de datos D1.** En el panel de Cloudflare → *Storage & Databases → D1 SQL Database* → *Create* → nombre `advent-of-kudos`.
2. **Proyecto de Pages.** *Workers & Pages* → *Create* → pestaña **Pages** → *Import an existing Git repository* → elige este repositorio.
   - *Framework preset:* `None`
   - *Build command:* (vacío)
   - *Build output directory:* `public`
   - Pulsa *Save and Deploy*.
3. **Conectar la base de datos.** En el proyecto → *Settings → Bindings* → *Add* → *D1 database*:
   - *Variable name:* `DB`
   - *D1 database:* `advent-of-kudos`
4. **Contraseña del organizador.** *Settings → Variables and Secrets* → *Add* → tipo **Secret**, nombre `ADMIN_PASSWORD`, valor la contraseña que quieras.
5. **Volver a desplegar** para que se apliquen los cambios: *Deployments* → en el último despliegue, menú `⋯` → *Retry deployment*.
6. Abre `https://<tu-proyecto>.pages.dev`, pulsa **Organizer** abajo del todo, entra con la contraseña y añade al equipo.

### Opcional: acceso solo para el equipo (Cloudflare Access)

Sin esto la web es pública y cada persona escribe su nombre al dejar kudos. Para que solo entre tu equipo y quede registrado su email verificado:

1. *Zero Trust → Access → Applications → Add an application → Self-hosted*, con el dominio `<tu-proyecto>.pages.dev` y una política que permita los emails (o el dominio) de tu equipo. Gratis hasta 50 usuarios.
2. En Pages → *Settings → Variables and Secrets* añade la variable `TRUST_ACCESS` = `1` y vuelve a desplegar.

Activa `TRUST_ACCESS` **solo** con Access configurado: sin Access, cualquiera podría hacerse pasar por otro email.

## Desarrollo local

```sh
npm install
npm run dev   # http://localhost:8788 · contraseña de organizador: letmein
```

Usa una base de datos D1 local (carpeta `.wrangler/`, ignorada por git).
