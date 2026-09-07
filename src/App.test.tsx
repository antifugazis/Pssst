import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

test('shows pssst ready to record', () => {
  render(<App />);
  expect(screen.getByText('pssst')).toBeInTheDocument();
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
