# Contributing to Moviq

Thanks for your interest in contributing! Here's how to get started.

## Getting started

1. Fork the repository and clone your fork.
2. Follow the setup instructions in [README.md](README.md#run-it-locally).
3. Create a feature branch from `master`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development workflow

- **Client** (`client/`): React 19 + Vite. Run `npm run dev` from the client directory.
- **Server** (`server/`): Express 5 + PostgreSQL. Run `npm run dev` from the server directory.
- **ML** (`ml/`): FastAPI + scikit-learn. Run `uvicorn main:app --port 8000` from the ml directory.

## Code style

- JavaScript/JSX: 2-space indentation, ES modules.
- Python: 4-space indentation, PEP 8.
- CSS: plain CSS with custom properties (no preprocessors).
- See `.editorconfig` for formatting defaults.

## Submitting changes

1. Keep commits focused — one logical change per commit.
2. Write clear commit messages describing *what* and *why*.
3. Make sure the app runs without errors before submitting.
4. Open a pull request against `master` with a description of your changes.

## Reporting issues

Use [GitHub Issues](https://github.com/Boovesh985/Moviq/issues) to report bugs or suggest features. Include:

- Steps to reproduce (for bugs)
- Expected vs actual behaviour
- Browser / OS / Node / Python version if relevant

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
