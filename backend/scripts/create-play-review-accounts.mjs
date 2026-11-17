/**
 * Titanium Sport Gym - cuentas temporales para revision de Google Play.
 * COLOCAR ESTE ARCHIVO EN backend/scripts/ (no lo ejecutes desde /mnt/data).
 * Ejecutar desde backend: node scripts/create-play-review-accounts.mjs --apply
 * No subir este script ni sus salidas a GitHub.
 */
import bcrypt from 'bcrypt';
import { Op } from 'sequelize';
import { sequelize } from '../config/sequelize.js';
import { User } from '../models/User.js';
import { TrainerProfile } from '../models/TrainerProfile.js';
import { generateRandomPassword } from '../utils/passwordPolicy.js';

const accounts = [
  {
    email: 'titaniumsportgym.app+trainer.review@gmail.com',
    role: 'entrenador',
  },
  {
    email: 'titaniumsportgym.app+admin.review@gmail.com',
    role: 'administrador',
  },
];

async function main() {
  console.log('Cuentas solicitadas para revision de Google Play:');
  for (const { email, role } of accounts) console.log(`- ${role}: ${email}`);

  if (!process.argv.includes('--apply')) {
    console.log('\nSimulacion: no se hicieron cambios.');
    console.log('Para crear las cuentas: node scripts/create-play-review-accounts.mjs --apply');
    return;
  }
  if (!process.env.DATABASE_URL_RUNTIME) {
    throw new Error('No esta configurada DATABASE_URL_RUNTIME en backend/.env');
  }

  // La administracion en la BD de produccion tiene privilegios reales.
  // No entregues esta cuenta a un revisor hasta asegurar que esta aislada o limitada.
  await sequelize.authenticate();
  const generated = await sequelize.transaction(async (transaction) => {
    const emails = accounts.map((account) => account.email);
    const existing = await User.findAll({
      where: { email: { [Op.in]: emails } },
      attributes: ['email'],
      transaction,
    });
    if (existing.length > 0) {
      throw new Error(
        `No se modifico nada: ya existe(n) ${existing.map((user) => user.email).join(', ')}. ` +
        'Para proteger las credenciales, el script no cambia contrasenas existentes.',
      );
    }

    const output = [];
    for (const { email, role } of accounts) {
      const password = generateRandomPassword(24);
      const user = await User.create(
        {
          email,
          password: await bcrypt.hash(password, 12),
          role,
          provider: 'local',
          authMethod: 'normal',
          isVerified: true,
          isPendingApproval: false,
          mustChangePassword: false,
        },
        { transaction },
      );

      if (role === 'entrenador') {
        await TrainerProfile.create(
          {
            trainerId: user.id,
            fullName: 'Google Play Demo Trainer',
            specialty: 'Demonstration account',
            experienceYears: 0,
            bio: 'Test profile for the Google Play application review.',
          },
          { transaction },
        );
      }
      output.push({ role, email, password });
    }
    return output;
  });

  console.log('\nCUENTAS CREADAS CORRECTAMENTE. Copia las claves a un lugar seguro:');
  for (const item of generated) {
    console.log(`\nROL: ${item.role}\nCORREO: ${item.email}\nCONTRASENA: ${item.password}`);
  }
  console.log('\nNo guardes estas claves en el repositorio, capturas o conversaciones.');
  console.log('Prueba el login de ambos roles desde la APK antes de usar las credenciales.');
  console.log('La cuenta de administrador NO debe compartirse sin una restriccion de permisos.');
}

main()
  .catch((err) => {
    console.error('No se completaron las cuentas:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
