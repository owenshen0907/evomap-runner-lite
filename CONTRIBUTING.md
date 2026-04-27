# Contributing

Thanks for improving EvoMap Runner Lite.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill `.env.local` with your own local EvoMap credentials. Never commit secrets, runtime logs, or cached payloads.

## Pull request checklist

- Keep EvoMap secrets server-side only.
- Preserve metadata-first fetch behavior before any full payload fetch.
- Add or update docs when behavior changes.
- Run `npm run build` before submitting.
- Keep UI defaults clear and status-first; hide advanced controls behind modals or detail panels.
