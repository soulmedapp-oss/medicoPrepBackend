const swaggerDocument = {
  openapi: '3.0.3',
  info: {
    title: 'MedicoPrep Backend API',
    version: '1.0.0',
    description: 'API docs for authentication, subscriptions, and admin helpers.',
  },
  servers: [
    {
      url: process.env.API_BASE_URL || process.env.CORS_ORIGIN || 'http://localhost:4000',
      description: 'Current backend server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      AuthRegister: {
        type: 'object',
        required: ['email', 'password', 'full_name'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
          full_name: { type: 'string' },
        },
      },
      AuthLogin: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
        },
      },
      AuthSafeUpdate: {
        type: 'object',
        properties: {
          full_name: { type: 'string' },
          phone: { type: 'string' },
          college: { type: 'string' },
          year_of_study: { type: 'string' },
          target_exam: { type: 'string' },
          profile_image: { type: 'string' },
        },
      },
      SubscriptionUpdate: {
        type: 'object',
        properties: {
          plan: { type: 'string' },
          status: { type: 'string' },
          start_date: { type: 'string', format: 'date' },
          end_date: { type: 'string', format: 'date' },
        },
      },
    },
  },
  tags: [
    { name: 'Auth', description: 'Authenticate and profile endpoints' },
    { name: 'Subscriptions', description: 'Admin subscription management' },
    { name: 'Admin', description: 'Admin utilities' },
  ],
  paths: {
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AuthRegister' } },
          },
        },
        responses: {
          201: { description: 'Registered successfully' },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login and receive JWT',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AuthLogin' } },
          },
        },
        responses: {
          200: { description: 'Returns user + token' },
          401: { description: 'Invalid credentials' },
          429: { description: 'Too many attempts' },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get current user',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Profile data' } },
      },
      patch: {
        tags: ['Auth'],
        summary: 'Update non-sensitive profile fields',
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AuthSafeUpdate' } },
          },
        },
        responses: {
          200: { description: 'Profile updated' },
          403: { description: 'Attempted forbidden fields' },
        },
      },
    },
    '/subscriptions': {
      get: {
        tags: ['Subscriptions'],
        summary: 'List subscriptions (admin can add all=true)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'all', in: 'query', schema: { type: 'string' }, description: 'Set to true for admin listing' },
        ],
        responses: { 200: { description: 'Subscriptions list' } },
      },
      post: {
        tags: ['Subscriptions'],
        summary: 'Create subscription (admin only)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SubscriptionUpdate' } },
          },
        },
        responses: { 201: { description: 'Subscription created' }, 403: { description: 'Admin required' } },
      },
    },
    '/subscriptions/{id}': {
      patch: {
        tags: ['Subscriptions'],
        summary: 'Update subscription (admin only)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SubscriptionUpdate' } },
          },
        },
        responses: { 200: { description: 'Updated' }, 403: { description: 'Admin required' } },
      },
      delete: {
        tags: ['Subscriptions'],
        summary: 'Deactivate subscription (admin only)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Deactivated' }, 403: { description: 'Admin required' } },
      },
    },
    '/subscriptions/{id}/extend': {
      post: {
        tags: ['Subscriptions'],
        summary: 'Extend subscription (admin only)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['extend_days'],
                properties: { extend_days: { type: 'integer', minimum: 1 } },
              },
            },
          },
        },
        responses: { 200: { description: 'Extended' }, 403: { description: 'Admin required' } },
      },
    },
    '/admin/debug/rate-limit': {
      get: {
        tags: ['Admin'],
        summary: 'See current rate-limit counters',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Stats payload' } },
      },
    },
  },
};

module.exports = swaggerDocument;
