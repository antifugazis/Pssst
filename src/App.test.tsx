import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { setLang } from './i18n';

test('shows Pssst ready to record', () => {
  render(<App />);
  expect(screen.getByText('Pssst')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /prêt à enregistrer/i })).toBeInTheDocument();
});

test('enables recording after choosing an available source and course', async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole('button', { name: /choisir une application/i }));
  await user.click(screen.getByRole('option', { name: /zoom workplace/i }));
  await user.type(screen.getByRole('combobox', { name: /^cours$/i }), 'Architecture des ordinateurs');

  expect(screen.getByRole('button', { name: /commencer l’enregistrement/i })).toBeEnabled();
});

test('switches the interface to English from Settings', async () => {
  const user = userEvent.setup();
  try {
    render(<App />);
    await user.click(screen.getByRole('button', { name: /réglages/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /langue/i }), 'en');

    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /set up your way/i })).toBeInTheDocument();
  } finally {
    setLang('fr');
  }
});
