// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const morgan = require("morgan");
const nodemailer = require("nodemailer");
const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

// =========================
// CONFIGURACIÓN DE URL DESDE .ENV
// =========================
const BASE_URL = process.env.BASE_URL || "https://kqgavtfrpt.us-east-1.awsapprunner.com";

console.log(`🔗 URL Base configurada: ${BASE_URL}`);

// CORS
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://ensurityexpress.com",
    "https://www.ensurityexpress.com",
    "https://ensurityexpress.bitrix24.com",
    BASE_URL
  ],
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  credentials: true
}));

// Middlewares
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan("combined"));

// =========================
// CONFIG SMTP (desde .env) - CORREGIDO: createTransport
// =========================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "mail.ensurityexpress.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Verificar conexión SMTP
transporter.verify(function (error) {
  if (error) {
    console.log("❌ Error configuración SMTP:", error);
  } else {
    console.log("✅ Servidor SMTP listo para enviar emails");
  }
});

// Almacenamientos en memoria
const paymentTokens = new Map();
const clientDataStore = new Map();

// =====================================
// CLASE AUTHORIZE.NET SERVICE - CORREGIDO CON POST
// =====================================
class AuthorizeNetService {
  constructor() {
    this.sandboxUrl = "https://apitest.authorize.net";
    this.productionUrl = "https://api.authorize.net";
    
    // Credenciales desde .env
    this.apiLoginId = process.env.AUTHORIZE_API_LOGIN_ID;
    this.transactionKey = process.env.AUTHORIZE_TRANSACTION_KEY;
    this.useSandbox = (process.env.AUTHORIZE_USE_SANDBOX || "false") === "true";

    // ✅ DEBUG CRÍTICO MEJORADO
    console.log('🚨 VERIFICACIÓN AUTHORIZE.NET CONFIGURACIÓN:', {
      environment: this.useSandbox ? 'SANDBOX' : 'PRODUCCIÓN',
      apiLoginId: this.apiLoginId ? `PRESENTE (${this.apiLoginId.substring(0, 4)}...)` : 'FALTANTE',
      transactionKey: this.transactionKey ? 'PRESENTE' : 'FALTANTE',
      baseUrl: this.getBaseUrl(),
      tokenBaseUrl: this.useSandbox ? 
        'https://test.authorize.net' : 
        'https://accept.authorize.net',
      baseUrl: BASE_URL
    });
  }

  getBaseUrl() {
    return this.useSandbox ? this.sandboxUrl : this.productionUrl;
  }

  generateReferenceId() {
    return `AUTH${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
  }

  // Crear transacción de pago
  async createTransaction(amount, paymentData) {
    try {
      console.log('🔄 Creando transacción en Authorize.Net...');

      const payload = {
        createTransactionRequest: {
          merchantAuthentication: {
            name: this.apiLoginId,
            transactionKey: this.transactionKey
          },
          transactionRequest: {
            transactionType: "authCaptureTransaction",
            amount: amount.toString(),
            payment: {
              creditCard: {
                cardNumber: paymentData.cardNumber,
                expirationDate: paymentData.expiry,
                cardCode: paymentData.cvv
              }
            },
            order: {
              invoiceNumber: `INV-${paymentData.entityId}-${Date.now()}`,
              description: `Payment for ${paymentData.entityType} ${paymentData.entityId}`
            },
            customer: {
              email: paymentData.customerEmail
            },
            billTo: {
              firstName: paymentData.customerName.split(' ')[0],
              lastName: paymentData.customerName.split(' ').slice(1).join(' ') || 'Customer',
              email: paymentData.customerEmail
            },
            userFields: {
              userField: [
                {
                  name: "entityType",
                  value: paymentData.entityType
                },
                {
                  name: "entityId", 
                  value: paymentData.entityId
                }
              ]
            }
          }
        }
      };

      console.log('📤 Enviando request a Authorize.Net:', {
        url: `${this.getBaseUrl()}/xml/v1/request.api`,
        payload: { ...payload, merchantAuthentication: { name: '***', transactionKey: '***' } }
      });

      const response = await axios.post(
        `${this.getBaseUrl()}/xml/v1/request.api`,
        payload,
        { 
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );

      console.log('✅ Respuesta de Authorize.Net:', response.data);

      const result = response.data;
      const transactionResponse = result.transactionResponse;

      if (transactionResponse && transactionResponse.responseCode === "1") {
        return {
          success: true,
          transactionId: transactionResponse.transId,
          authCode: transactionResponse.authCode,
          referenceId: this.generateReferenceId(),
          invoiceNumber: payload.createTransactionRequest.transactionRequest.order.invoiceNumber,
          cardData: {
            accountNumber: transactionResponse.accountNumber,
            accountType: transactionResponse.accountType
          },
          fullResponse: result
        };
      } else {
        const errorMsg = transactionResponse?.errors?.error?.[0]?.errorText || 
                        result.messages?.message?.[0]?.text ||
                        'Transacción fallida en Authorize.Net';
        throw new Error(errorMsg);
      }

    } catch (error) {
      console.error('❌ Error procesando transacción con Authorize.Net:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });

      const errorMessage = error.response?.data?.messages?.message?.[0]?.text ||
                          error.response?.data?.transactionResponse?.errors?.error?.[0]?.errorText ||
                          error.message;

      throw new Error(errorMessage);
    }
  }

  // Crear Hosted Payment Page (HPP) - CORREGIDO PARA POST
  async createHostedPaymentPage(paymentData) {
    try {
      console.log('🔄 Creando página de pago hospedada...');
      console.log('📝 Datos de pago:', {
        client: paymentData.customerName,
        email: paymentData.customerEmail,
        amount: paymentData.amount,
        entity: `${paymentData.entityType}-${paymentData.entityId}`
      });

      const tokenPayload = {
        getHostedPaymentPageRequest: {
          merchantAuthentication: {
            name: this.apiLoginId,
            transactionKey: this.transactionKey
          },
          transactionRequest: {
            transactionType: "authCaptureTransaction",
            amount: paymentData.amount.toString(),
            order: {
              invoiceNumber: `INV-${paymentData.entityId}-${Date.now()}`,
              description: `Payment for ${paymentData.entityType} ${paymentData.entityId}`
            },
            customer: {
              email: paymentData.customerEmail
            }
          },
          hostedPaymentSettings: {
            setting: [
              {
                settingName: "hostedPaymentReturnOptions",
                settingValue: JSON.stringify({
                  showReceipt: true,
                  url: `${BASE_URL}/authorize/return`,
                  urlText: "Continue",
                  cancelUrl: `${BASE_URL}/authorize/cancel`,
                  cancelUrlText: "Cancel"
                })
              },
              {
                settingName: "hostedPaymentButtonOptions", 
                settingValue: JSON.stringify({
                  text: "Pay Now"
                })
              },
              {
                settingName: "hostedPaymentStyleOptions",
                settingValue: JSON.stringify({
                  bgColor: "#041539"
                })
              },
              {
                settingName: "hostedPaymentPaymentOptions",
                settingValue: JSON.stringify({
                  cardCodeRequired: true,
                  showCreditCard: true
                })
              },
              {
                settingName: "hostedPaymentBillingAddressOptions",
                settingValue: JSON.stringify({
                  show: false,
                  required: false
                })
              },
              {
                settingName: "hostedPaymentCustomerOptions",
                settingValue: JSON.stringify({
                  showEmail: false,
                  requiredEmail: false,
                  addPaymentProfile: false
                })
              }
            ]
          }
        }
      };

      console.log('📤 Enviando request HPP a Authorize.Net:', {
        url: `${this.getBaseUrl()}/xml/v1/request.api`,
        environment: this.useSandbox ? 'SANDBOX' : 'PRODUCCIÓN'
      });

      const response = await axios.post(
        `${this.getBaseUrl()}/xml/v1/request.api`,
        tokenPayload,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );

      console.log('✅ Respuesta HPP Authorize.Net:', JSON.stringify(response.data, null, 2));

      const result = response.data;
      
      if (result.token) {
        // ✅ CORRECCIÓN CRÍTICA: DEVOLVER URL BASE Y TOKEN POR SEPARADO PARA POST
        const postUrl = `${this.useSandbox ? 'https://test.authorize.net' : 'https://accept.authorize.net'}/payment/payment`;
        
        console.log('🔗 URL de pago (POST):', postUrl);
        console.log('🔍 Token para POST:', result.token.substring(0, 50) + '...');
        
        return {
          success: true,
          postUrl: postUrl,
          token: result.token,
          referenceId: this.generateReferenceId(),
          message: "Página de pago hospedada generada exitosamente"
        };
      } else {
        const errorMsg = result.messages?.message?.[0]?.text || "Error generando página de pago";
        console.error('❌ Error en respuesta HPP:', errorMsg);
        throw new Error(errorMsg);
      }

    } catch (error) {
      console.error('💥 Error creando HPP:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        url: error.config?.url
      });
      throw error;
    }
  }

  // Verificar estado de transacción
  async getTransactionStatus(transactionId) {
    try {
      const payload = {
        getTransactionDetailsRequest: {
          merchantAuthentication: {
            name: this.apiLoginId,
            transactionKey: this.transactionKey
          },
          transId: transactionId
        }
      };

      const response = await axios.post(
        `${this.getBaseUrl()}/xml/v1/request.api`,
        payload,
        { headers: { 'Content-Type': 'application/json' } }
      );

      return response.data;
    } catch (error) {
      console.error('❌ Error verificando transacción:', error.response?.data || error.message);
      throw error;
    }
  }
}

// =====================================
// CLASE Bitrix24
// =====================================
class Bitrix24 {
  constructor() {
    this.webhookUrl = process.env.BITRIX24_WEBHOOK_URL || "https://ensurityexpress.bitrix24.com/rest/65/v6hyou7s4l7fpj5l";
  }

  async getDeal(dealId) {
    try {
      console.log(`🔍 Obteniendo deal ${dealId}...`);
      const response = await axios.get(`${this.webhookUrl}/crm.deal.get`, {
        params: { id: dealId }
      });

      if (response.data.result) {
        console.log(`✅ Deal obtenido:`, {
          title: response.data.result.TITLE,
          contactId: response.data.result.CONTACT_ID,
          stageId: response.data.result.STAGE_ID
        });
      }

      return response.data.result;
    } catch (error) {
      console.error('❌ Error obteniendo deal:', error.message);
      throw error;
    }
  }

  async getContactFromDeal(dealId) {
    try {
      console.log(`🔍 Obteniendo contacto desde deal ${dealId}...`);
      const deal = await this.getDeal(dealId);

      if (deal && deal.CONTACT_ID && deal.CONTACT_ID !== "0") {
        console.log(`✅ Deal tiene contacto asociado: ${deal.CONTACT_ID}`);
        const contact = await this.getContact(deal.CONTACT_ID);
        return contact;
      } else {
        console.log('❌ Deal no tiene contacto asociado válido');
        return null;
      }
    } catch (error) {
      console.error('❌ Error obteniendo contacto desde deal:', error.message);
      return null;
    }
  }

  async getContact(contactId) {
    try {
      console.log(`🔍 Obteniendo contacto ${contactId}...`);
      const response = await axios.get(`${this.webhookUrl}/crm.contact.get`, {
        params: { id: contactId }
      });

      if (response.data.result) {
        console.log(`✅ Contacto obtenido:`, {
          name: `${response.data.result.NAME || ''} ${response.data.result.LAST_NAME || ''}`,
          email: response.data.result.EMAIL?.[0]?.VALUE || 'No disponible',
          phone: response.data.result.PHONE?.[0]?.VALUE || 'No disponible'
        });
      }

      return response.data.result;
    } catch (error) {
      console.error('❌ Error obteniendo contacto:', error.message);
      throw error;
    }
  }

  async updateDeal(dealId, data) {
    try {
      console.log(`🔄 Actualizando deal ${dealId}...`);
      const response = await axios.post(`${this.webhookUrl}/crm.deal.update`, {
        id: dealId,
        fields: data
      });
      console.log(`✅ Deal actualizado exitosamente`);
      return response.data.result;
    } catch (error) {
      console.error('❌ Error actualizando deal:', error.message);
      throw error;
    }
  }
}

// Inicializar servicios
const authorizeService = new AuthorizeNetService();
const bitrix24 = new Bitrix24();

// Generar token seguro
function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ================================
// FUNCIONES DE EMAIL
// ================================
async function sendPaymentEmail(email, clientName, paymentLink, dealId) {
  try {
    const mailOptions = {
      from: `"EG Express Payments" <${process.env.SMTP_USER || "invoice@ensurityexpress.com"}>`,
      to: email,
      subject: `Link de Pago - Deal #${dealId}`,
      html: `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #041539 0%, #1a365d 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .payment-link { background: #28a745; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; font-weight: bold; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>💰 EG Express Payments</h1>
        <p>Sistema de Pagos Seguro</p>
    </div>

    <div class="content">
        <h2>Hola ${clientName},</h2>
        <p>Has recibido un link de pago seguro para completar tu transacción.</p>

        <p><strong>Referencia:</strong> Deal #${dealId}</p>

        <div style="text-align: center; margin: 30px 0;">
            <a href="${paymentLink}" class="payment-link" target="_blank">
                🚀 Acceder al Portal de Pagos Authorize.Net
            </a>
        </div>

        <p><strong>⚠️ Importante:</strong></p>
        <ul>
            <li>Este link es válido por 24 horas</li>
            <li>Es seguro y está protegido con encriptación</li>
            <li>No compartas este link con otras personas</li>
        </ul>

        <p>Si tienes alguna pregunta, contáctanos.</p>
    </div>

    <div class="footer">
        <p>EG Express Payments System<br>
        <small>Este es un email automático, por favor no respondas a este mensaje.</small></p>
    </div>
</body>
</html>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email enviado a: ${email}`);
    return info;
  } catch (error) {
    console.error('❌ Error enviando email:', error);
    throw error;
  }
}

async function sendPaymentConfirmation(email, paymentData) {
  try {
    const mailOptions = {
      from: `"EG Express Payments" <${process.env.SMTP_USER || "invoice@ensurityexpress.com"}>`,
      to: email,
      subject: `✅ Confirmación de Pago - ${paymentData.transactionId}`,
      html: `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .receipt { background: white; padding: 20px; border-radius: 5px; border-left: 4px solid #28a745; margin: 20px 0; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="header">
        <h1>✅ Pago Confirmado</h1>
        <p>EG Express Payments</p>
    </div>

    <div class="content">
        <h2>Hola ${paymentData.clientName},</h2>
        <p>Tu pago ha sido procesado exitosamente a través de Authorize.Net.</p>

        <div class="receipt">
            <h3>📋 Comprobante de Pago</h3>
            <p><strong>Monto:</strong> $${paymentData.amount}</p>
            <p><strong>ID de Transacción:</strong> ${paymentData.transactionId}</p>
            <p><strong>Código de Autorización:</strong> ${paymentData.authCode || 'N/A'}</p>
            <p><strong>Referencia:</strong> ${paymentData.referenceId || paymentData.transactionId}</p>
            <p><strong>Procesador:</strong> Authorize.Net</p>
            <p><strong>Fecha:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Hora:</strong> ${new Date().toLocaleTimeString()}</p>
        </div>

        <p>Hemos registrado tu pago en nuestro sistema. Este comprobante sirve como recibo oficial.</p>

        <p><strong>Gracias por confiar en EG Express.</strong></p>
    </div>

    <div class="footer">
        <p>EG Express Payments System<br>
        <small>Este es un email automático, por favor no respondas a este mensaje.</small></p>
    </div>
</body>
</html>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email de confirmación enviado a: ${email}`);
    return info;
  } catch (error) {
    console.error('❌ Error enviando email de confirmación:', error);
    throw error;
  }
}

// =====================================
// RUTA PRINCIPAL DEL WIDGET BITRIX24
// =====================================
app.post("/widget/bitrix24", async (req, res) => {
  console.log("🎯 WIDGET BITRIX24 LLAMADO (POST)");
  console.log("PLACEMENT:", req.body.PLACEMENT);
  console.log("PLACEMENT_OPTIONS:", req.body.PLACEMENT_OPTIONS);

  try {
    const { PLACEMENT_OPTIONS, PLACEMENT } = req.body;

    let contactData = null;
    let entityId = null;
    let entityType = null;
    let hasValidContact = true;

    if (PLACEMENT_OPTIONS) {
      let options;

      if (typeof PLACEMENT_OPTIONS === 'string') {
        options = JSON.parse(PLACEMENT_OPTIONS);
      } else {
        options = PLACEMENT_OPTIONS;
      }

      entityId = options.ID;

      if (PLACEMENT === 'CRM_CONTACT_DETAIL_TAB') {
        entityType = 'contact';
        console.log(`👤 Es un CONTACTO: ${entityId}`);
        contactData = await bitrix24.getContact(entityId);
      } else if (PLACEMENT === 'CRM_DEAL_DETAIL_TAB') {
        entityType = 'deal';
        console.log(`💼 Es un DEAL: ${entityId}`);
        contactData = await bitrix24.getContactFromDeal(entityId);

        if (!contactData) {
          hasValidContact = false;
        }
      }
    }

    let widgetHTML;

    if (!hasValidContact) {
      widgetHTML = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>EG Express Payments</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
                .widget-container { width: 100%; max-width: 500px; background: white; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); overflow: hidden; }
                .header { background: linear-gradient(135deg, #041539 0%, #1a365d 100%); color: white; padding: 25px; text-align: center; border-bottom: 4px solid #ff9900; }
                .content { padding: 25px; text-align: center; }
                .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
                .btn { background: linear-gradient(135deg, #6c757d 0%, #495057 100%); color: white; padding: 15px 25px; border: none; border-radius: 8px; cursor: pointer; margin: 10px 0; width: 100%; font-size: 16px; font-weight: 600; }
            </style>
        </head>
        <body>
            <div class="widget-container">
                <div class="header">
                    <h2>💰 EG Express Payments</h2>
                    <p>Sistema de Pagos con Authorize.Net</p>
                </div>
                <div class="content">
                    <div class="warning">
                        <h3>⚠️ Información Requerida</h3>
                        <p>Este ${entityType} no tiene un contacto asociado válido.</p>
                        <p>Por favor asigna un contacto al ${entityType} para generar links de pago.</p>
                    </div>
                    <button class="btn" onclick="testConnection()">
                        🔗 Probar Conexión
                    </button>
                    <div id="result" style="margin-top: 20px;"></div>
                </div>
            </div>
            <script>
                async function testConnection() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = '<div style="text-align: center;">⏳ Probando conexión...</div>';
                    try {
                        const response = await fetch('${BASE_URL}/health');
                        const result = await response.json();
                        resultDiv.innerHTML = '<div style="color: #28a745;">✅ Conexión exitosa con el servidor</div>';
                    } catch (error) {
                        resultDiv.innerHTML = '<div style="color: #dc3545;">❌ Error de conexión</div>';
                    }
                }
            </script>
        </body>
        </html>
      `;
    } else {
      const clientEmail = contactData?.EMAIL?.[0]?.VALUE || "No disponible";
      const clientName = contactData ? `${contactData.NAME || ''} ${contactData.LAST_NAME || ''}`.trim() : "Cliente no disponible";
      const clientPhone = contactData?.PHONE?.[0]?.VALUE || "No disponible";

      widgetHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>EG Express Payments</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .widget-container { width: 100%; max-width: 500px; background: white; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); overflow: hidden; }
        .header { background: linear-gradient(135deg, #041539 0%, #1a365d 100%); color: white; padding: 25px; text-align: center; border-bottom: 4px solid #ff9900; }
        .header h2 { margin: 0; font-size: 24px; font-weight: 600; }
        .header p { margin: 5px 0 0 0; opacity: 0.9; }
        .content { padding: 25px; }
        .client-info { background: #f8f9fa; padding: 20px; border-radius: 10px; margin-bottom: 20px; border-left: 4px solid #28a745; }
        .client-info h3 { color: #041539; margin-bottom: 15px; font-size: 18px; display: flex; align-items: center; gap: 10px; }
        .info-item { display: flex; align-items: center; margin-bottom: 8px; padding: 8px 0; }
        .info-icon { width: 20px; text-align: center; margin-right: 10px; color: #041539; }
        .btn { background: linear-gradient(135deg, #007bff 0%, #0056b3 100%); color: white; padding: 15px 25px; border: none; border-radius: 8px; cursor: pointer; margin: 10px 0; width: 100%; font-size: 16px; font-weight: 600; transition: all 0.3s ease; display: flex; align-items: center; justify-content: center; gap: 10px; }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(0,123,255,0.3); }
        .btn-success { background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%); }
        .btn-success:hover { box-shadow: 0 10px 20px rgba(40,167,69,0.3); }
        .btn-secondary { background: linear-gradient(135deg, #6c757d 0%, #495057 100%); }
        .btn-secondary:hover { box-shadow: 0 10px 20px rgba(108,117,125,0.3); }
        .result { margin-top: 20px; padding: 20px; border-radius: 10px; background: white; border: 2px solid transparent; transition: all 0.3s ease; }
        .success { border-color: #28a745; background: #f8fff9; }
        .error { border-color: #dc3545; background: #fff5f5; }
        .link-display { word-break: break-all; padding: 15px; background: #e9ecef; border-radius: 8px; margin: 15px 0; font-size: 14px; border: 1px dashed #6c757d; }
        .loading { display: inline-block; width: 20px; height: 20px; border: 3px solid #f3f3f3; border-top: 3px solid #007bff; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .email-section { background: #e7f3ff; padding: 15px; border-radius: 8px; margin: 15px 0; border: 1px solid #b3d9ff; }
    </style>
</head>
<body>
    <div class="widget-container">
        <div class="header">
            <h2>💰 EG Express Payments</h2>
            <p>Sistema de Pagos con Authorize.Net</p>
        </div>

        <div class="content">
            <div class="client-info">
                <h3>👤 Información del Cliente</h3>
                <div class="info-item">
                    <span class="info-icon">👤</span>
                    <strong>Nombre:</strong> ${clientName}
                </div>
                <div class="info-item">
                    <span class="info-icon">📧</span>
                    <strong>Email:</strong> ${clientEmail}
                </div>
                <div class="info-item">
                    <span class="info-icon">📞</span>
                    <strong>Teléfono:</strong> ${clientPhone}
                </div>
                <div class="info-item">
                    <span class="info-icon">🆔</span>
                    <strong>ID:</strong> ${entityId} (${entityType})
                </div>
            </div>

            <button class="btn" onclick="generatePaymentLink()">
                🎯 Generar Link de Pago Authorize.Net
            </button>

            <button class="btn btn-secondary" onclick="sendPaymentEmailToClient()">
                📧 Enviar Link por Email
            </button>

            <button class="btn btn-secondary" onclick="testConnection()">
                🔗 Probar Conexión
            </button>

            <div id="result" class="result"></div>
        </div>
    </div>

    <script>
        const SERVER_URL = '${BASE_URL}';
        const CLIENT_EMAIL = '${clientEmail}';
        const CLIENT_NAME = '${clientName}';
        const ENTITY_ID = '${entityId}';
        const ENTITY_TYPE = '${entityType}';

        async function generatePaymentLink() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<div style="text-align: center;"><div class="loading"></div><br>⏳ Generando link de pago seguro...</div>';
            resultDiv.className = 'result';

            try {
                const response = await fetch(SERVER_URL + '/webhook/bitrix24', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        PLACEMENT_OPTIONS: JSON.stringify({
                            ENTITY_ID: ENTITY_ID,
                            ENTITY_TYPE: ENTITY_TYPE,
                            CONTACT_EMAIL: CLIENT_EMAIL,
                            CONTACT_NAME: CLIENT_NAME
                        })
                    })
                });

                const result = await response.json();

                if (result.success) {
                    resultDiv.innerHTML =
                        '<div style="color: #28a745; text-align: center;">' +
                        '✅ <strong>Link generado exitosamente!</strong></div><br>' +
                        '<strong>🔗 Enlace de Pago Seguro:</strong><br>' +
                        '<div class="link-display">' + result.paymentLink + '</div><br>' +
                        '<button class="btn btn-success" onclick="copyToClipboard(\\'' + result.paymentLink + '\\')">📋 Copiar Link</button>' +
                        '<div style="margin-top: 15px; padding: 10px; background: #e7f3ff; border-radius: 5px; font-size: 12px; color: #0066cc;">' +
                        '💡 <strong>Instrucciones:</strong> Envía este link al cliente para que complete el pago de forma segura.' +
                        '</div>';
                    resultDiv.className = 'result success';
                } else {
                    resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Error:</strong> ' + (result.error || 'Error generando link') + '</div>';
                    resultDiv.className = 'result error';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Error de conexión:</strong> ' + error.message + '</div>';
                resultDiv.className = 'result error';
            }
        }

        async function sendPaymentEmailToClient() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<div style="text-align: center;"><div class="loading"></div><br>📧 Enviando email al cliente...</div>';
            resultDiv.className = 'result';

            try {
                const response = await fetch(SERVER_URL + '/api/send-payment-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        entityId: ENTITY_ID,
                        entityType: ENTITY_TYPE,
                        clientEmail: CLIENT_EMAIL,
                        clientName: CLIENT_NAME
                    })
                });

                const result = await response.json();

                if (result.success) {
                    resultDiv.innerHTML =
                        '<div style="color: #28a745; text-align: center;">' +
                        '✅ <strong>Email enviado exitosamente!</strong></div><br>' +
                        '<div class="email-section">' +
                        '<strong>📧 Destinatario:</strong> ' + CLIENT_EMAIL + '<br>' +
                        '<strong>👤 Cliente:</strong> ' + CLIENT_NAME + '<br>' +
                        '<strong>🆔 Referencia:</strong> ' + ENTITY_TYPE + '-' + ENTITY_ID +
                        '</div>' +
                        '<div style="margin-top: 15px; padding: 10px; background: #d4edda; border-radius: 5px; font-size: 12px; color: #155724;">' +
                        '💡 El cliente recibió el link de pago por email. Puedes hacer seguimiento desde Bitrix24.' +
                        '</div>';
                    resultDiv.className = 'result success';
                } else {
                    resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Error:</strong> ' + (result.error || 'Error enviando email') + '</div>';
                    resultDiv.className = 'result error';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Error de conexión:</strong> ' + error.message + '</div>';
                resultDiv.className = 'result error';
            }
        }

        async function testConnection() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<div style="text-align: center;"><div class="loading"></div><br>⏳ Probando conexión...</div>';
            resultDiv.className = 'result';

            try {
                const response = await fetch(SERVER_URL + '/health');
                const result = await response.json();
                resultDiv.innerHTML =
                    '<div style="color: #28a745; text-align: center;">' +
                    '✅ <strong>Conexión exitosa!</strong></div><br>' +
                    '<div style="text-align: left;">' +
                    '<div><strong>Servidor:</strong> ' + result.server + '</div>' +
                    '<div><strong>URL:</strong> ' + SERVER_URL + '</div>' +
                    '<div><strong>Authorize.Net:</strong> ' + (result.authorize?.environment || 'No configurado') + '</div>' +
                    '</div>';
                    resultDiv.className = 'result success';
            } catch (error) {
                resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Error de conexión</strong><br>' + error.message + '</div>';
                resultDiv.className = 'result error';
            }
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('✅ Link copiado al portapapeles');
            });
        }

        // Test automático
        window.addEventListener('load', function () {
            setTimeout(testConnection, 1000);
        });
    </script>
</body>
</html>
      `;
    }

    console.log("✅ Enviando HTML del widget a Bitrix24");
    res.send(widgetHTML);

  } catch (error) {
    console.error("💥 Error en widget:", error);
    res.status(500).send(`
      <div style="padding: 20px; background: #f8d7da; color: #721c24; border-radius: 8px; text-align: center;">
        <h3>❌ Error en el Widget</h3>
        <p><strong>Detalles:</strong> ${error.message}</p>
        <button style="padding: 10px 20px; background: #dc3545; color: white; border: none; border-radius: 5px; cursor: pointer;" 
                onclick="location.reload()">🔄 Reintentar</button>
      </div>
    `);
  }
});

// =====================================
// WEBHOOK PARA GENERAR LINKS DE PAGO
// =====================================
app.post("/webhook/bitrix24", async (req, res) => {
  console.log("🔗 WEBHOOK BITRIX24 LLAMADO");
  console.log("Body:", req.body);

  try {
    const { PLACEMENT_OPTIONS } = req.body;

    if (!PLACEMENT_OPTIONS) {
      return res.status(400).json({
        success: false,
        error: "PLACEMENT_OPTIONS no encontrado"
      });
    }

    let options;
    try {
      options = typeof PLACEMENT_OPTIONS === 'string'
        ? JSON.parse(PLACEMENT_OPTIONS)
        : PLACEMENT_OPTIONS;
    } catch (parseError) {
      return res.status(400).json({
        success: false,
        error: "PLACEMENT_OPTIONS no es un JSON válido"
      });
    }

    const entityId = options.ENTITY_ID;
    const entityType = options.ENTITY_TYPE;
    const contactEmail = options.CONTACT_EMAIL;
    const contactName = options.CONTACT_NAME;

    if (!entityId) {
      return res.status(400).json({
        success: false,
        error: "Entity ID no encontrado"
      });
    }

    // Generar token seguro
    const token = generateSecureToken();
    const tokenData = {
      entityId,
      entityType,
      contactEmail,
      contactName,
      timestamp: Date.now(),
      expires: Date.now() + (24 * 60 * 60 * 1000)
    };

    paymentTokens.set(token, tokenData);
    console.log(`✅ Token generado para ${entityType} ${entityId}`);

    // Generar link de pago
    const paymentLink = `${BASE_URL}/payment/${token}`;

    res.json({
      success: true,
      paymentLink: paymentLink,
      entityId: entityId,
      entityType: entityType,
      contactEmail: contactEmail,
      message: "Link de pago generado exitosamente"
    });

  } catch (error) {
    console.error("❌ Error en webhook:", error);
    res.status(500).json({
      success: false,
      error: "Error al procesar la solicitud"
    });
  }
});

// =====================================
// RUTA DE PAGO CON TOKEN - FORMULARIO PROPIO CON AUTHORIZE.NET HPP
// =====================================
app.get("/payment/:token", async (req, res) => {
  const { token } = req.params;

  console.log(`🔐 Accediendo a pago con token: ${token.substring(0, 10)}...`);

  try {
    const tokenData = paymentTokens.get(token);

    if (!tokenData) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Link Inválido - EG Express</title>
            <style>
                body { font-family: Arial, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                .error-icon { font-size: 64px; color: #dc3545; margin-bottom: 20px; }
                h1 { color: #dc3545; margin-bottom: 15px; }
                p { color: #6c757d; margin-bottom: 20px; line-height: 1.6; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="error-icon">❌</div>
                <h1>Link Inválido o Expirado</h1>
                <p>Este link de pago ha expirado o es inválido.</p>
                <p>Por favor solicita un nuevo link de pago al agente.</p>
            </div>
        </body>
        </html>
      `);
    }

    // Verificar expiración
    if (Date.now() > tokenData.expires) {
      paymentTokens.delete(token);
      console.log('⏰ Token expirado');
      return res.status(410).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Link Expirado - EG Express</title>
            <style>
                body { font-family: Arial, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                .error-icon { font-size: 64px; color: #ffc107; margin-bottom: 20px; }
                h1 { color: #856404; margin-bottom: 15px; }
                p { color: #6c757d; margin-bottom: 20px; line-height: 1.6; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="error-icon">⏰</div>
                <h1>Link Expirado</h1>
                <p>Este link de pago ha expirado.</p>
                <p>Por favor solicita un nuevo link al agente.</p>
            </div>
        </body>
        </html>
      `);
    }

    console.log(`✅ Token válido para: ${tokenData.contactName} (${tokenData.contactEmail})`);

    // FORMULARIO DE PAGO PROPIO CON AUTHORIZE.NET HPP
    const paymentForm = `
<!DOCTYPE html>
<html>
<head>
    <title>EG Express - Portal de Pagos Seguro</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0; padding: 20px; min-height: 100vh;
            display: flex; align-items: center; justify-content: center;
        }
        .payment-container {
            background: white; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            overflow: hidden; width: 100%; max-width: 500px;
        }
        .payment-header {
            background: linear-gradient(135deg, #041539 0%, #1a365d 100%);
            color: white; padding: 30px; text-align: center; border-bottom: 4px solid #ff9900;
        }
        .payment-header h1 { margin: 0; font-size: 28px; font-weight: 600; }
        .payment-header p { margin: 10px 0 0 0; opacity: 0.9; }
        .payment-content { padding: 30px; }
        .client-summary {
            background: #f8f9fa; padding: 20px; border-radius: 10px; margin-bottom: 25px;
            border-left: 4px solid #28a745;
        }
        .form-group { margin-bottom: 20px; }
        .form-group label {
            display: block; margin-bottom: 8px; font-weight: 600; color: #041539;
        }
        .form-group input {
            width: 100%; padding: 12px 15px; border: 2px solid #e9ecef; border-radius: 8px;
            font-size: 16px; transition: border-color 0.3s ease;
        }
        .form-group input:focus {
            outline: none; border-color: #007bff; box-shadow: 0 0 0 3px rgba(0,123,255,0.1);
        }
        .btn-pay {
            background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%);
            color: white; border: none; padding: 15px 25px; border-radius: 8px;
            font-size: 18px; font-weight: 600; width: 100%; cursor: pointer;
            transition: all 0.3s ease; display: flex; align-items: center;
            justify-content: center; gap: 10px; margin-top: 10px;
        }
        .btn-pay:hover:not(:disabled) {
            transform: translateY(-2px); box-shadow: 0 10px 20px rgba(40,167,69,0.3);
        }
        .btn-pay:disabled {
            background: #6c757d; cursor: not-allowed; opacity: 0.7;
        }
        .security-notice {
            background: #e7f3ff; padding: 15px; border-radius: 8px; margin-top: 20px;
            text-align: center; font-size: 14px; color: #0066cc; border: 1px solid #b3d9ff;
        }
        .loading { 
            display: inline-block; width: 20px; height: 20px; 
            border: 3px solid #f3f3f3; border-top: 3px solid #007bff; 
            border-radius: 50%; animation: spin 1s linear infinite; 
        }
        @keyframes spin { 
            0% { transform: rotate(0deg); } 
            100% { transform: rotate(360deg); } 
        }
        .result-message { 
            padding: 15px; border-radius: 8px; margin: 15px 0; text-align: center; 
            display: none; 
        }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    </style>
</head>
<body>
    <div class="payment-container">
        <div class="payment-header">
            <h1>💳 Portal de Pagos Seguro</h1>
            <p>EG Express - Procesado con Authorize.Net</p>
        </div>

        <div class="payment-content">
            <div class="client-summary">
                <h3 style="margin: 0 0 15px 0; color: #041539;">Resumen del Pago</h3>
                <p><strong>👤 Cliente:</strong> ${tokenData.contactName}</p>
                <p><strong>📧 Email:</strong> ${tokenData.contactEmail}</p>
                <p><strong>🆔 Referencia:</strong> ${(tokenData.entityType || 'DEAL').toUpperCase()}-${tokenData.entityId}</p>
                <p><strong>🏦 Entorno:</strong> ${authorizeService.useSandbox ? 'SANDBOX (Pruebas)' : 'PRODUCCIÓN'}</p>
            </div>

            <form id="paymentForm">
                <div class="form-group">
                    <label for="amount">💵 Monto a Pagar (USD)</label>
                    <input type="number" id="amount" name="amount" 
                           placeholder="0.00" min="1" step="0.01" 
                           value="20.80" required>
                </div>

                <button type="submit" class="btn-pay" id="submitBtn">
                    <span id="btnText">🚀 Generar Link de Pago Authorize.Net</span>
                    <div id="btnLoading" class="loading" style="display: none;"></div>
                </button>
            </form>

            <div id="resultMessage" class="result-message"></div>

            <div class="security-notice">
                🔒 Serás redirigido a una página de pago segura de Authorize.Net. 
                Tus datos están protegidos con encriptación SSL.
            </div>
        </div>
    </div>

    <script>
        const TOKEN = '${token}';
        const SERVER_URL = '${BASE_URL}';

        // Manejar envío del formulario
        document.getElementById('paymentForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const submitBtn = document.getElementById('submitBtn');
            const btnText = document.getElementById('btnText');
            const btnLoading = document.getElementById('btnLoading');
            const resultMessage = document.getElementById('resultMessage');

            // Mostrar loading
            submitBtn.disabled = true;
            btnText.style.display = 'none';
            btnLoading.style.display = 'inline-block';
            resultMessage.style.display = 'none';

            // Obtener datos del formulario
            const amount = document.getElementById('amount').value;

            try {
                console.log('Generando link de pago Authorize.Net...');

                const response = await fetch(SERVER_URL + '/api/generate-authorize-link', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        token: TOKEN,
                        amount: amount
                    })
                });

                const result = await response.json();

                if (result.success) {
                    // ✅ CORRECCIÓN: Crear formulario POST automático para Authorize.Net
                    const form = document.createElement('form');
                    form.method = 'POST';
                    form.action = result.postUrl;
                    form.style.display = 'none';

                    const tokenInput = document.createElement('input');
                    tokenInput.type = 'hidden';
                    tokenInput.name = 'token';
                    tokenInput.value = result.token;

                    form.appendChild(tokenInput);
                    document.body.appendChild(form);

                    // Mostrar éxito y enviar formulario
                    resultMessage.innerHTML = 
                        '✅ <strong>¡Link Generado!</strong><br>' +
                        'Redirigiendo a página de pago segura de Authorize.Net...';
                    resultMessage.className = 'result-message success';
                    resultMessage.style.display = 'block';

                    // Enviar formulario automáticamente
                    setTimeout(() => {
                        form.submit();
                    }, 1500);

                } else {
                    throw new Error(result.error || 'Error generando link de pago');
                }

            } catch (error) {
                console.error('Error:', error);
                resultMessage.innerHTML = 
                    '❌ <strong>Error al Generar Link</strong><br>' +
                    error.message + '<br><br>' +
                    '<button onclick="location.reload()" style="background: #dc3545; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">🔄 Reintentar</button>';
                resultMessage.className = 'result-message error';
                resultMessage.style.display = 'block';
            } finally {
                // Restaurar botón
                submitBtn.disabled = false;
                btnText.style.display = 'inline';
                btnLoading.style.display = 'none';
            }
        });

        // Datos de prueba para desarrollo
        if (window.location.hostname === 'localhost' || window.location.hostname.includes('ngrok')) {
            console.log('Modo desarrollo activado');
        }
    </script>
</body>
</html>
    `;

    res.send(paymentForm);

  } catch (error) {
    console.error('❌ Error en página de pago:', error);
    res.status(500).send(`
      <div style="padding: 40px; text-align: center;">
        <h2 style="color: #dc3545;">Error del Servidor</h2>
        <p>No se pudo cargar la página de pago. Por favor intenta nuevamente.</p>
      </div>
    `);
  }
});

// =====================================
// API PARA GENERAR LINK AUTHORIZE.NET HPP - CORREGIDO CON POST
// =====================================
app.post("/api/generate-authorize-link", async (req, res) => {
  console.log("🔗 SOLICITUD DE GENERACIÓN AUTHORIZE.NET HPP");

  try {
    const { token, amount } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token no proporcionado"
      });
    }

    const tokenData = paymentTokens.get(token);

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        error: "Token inválido o expirado"
      });
    }

    // Validar monto
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: "Monto inválido. Debe ser mayor a 0"
      });
    }

    console.log('🔄 Generando link Authorize.Net para:', {
      client: tokenData.contactName,
      email: tokenData.contactEmail,
      amount: amount,
      entity: `${tokenData.entityType}-${tokenData.entityId}`
    });

    // Generar link HPP de Authorize.Net
    const hppResult = await authorizeService.createHostedPaymentPage({
      amount: amount,
      customerName: tokenData.contactName,
      customerEmail: tokenData.contactEmail,
      entityId: tokenData.entityId,
      entityType: tokenData.entityType
    });

    // Guardar la referencia en la sesión
    tokenData.authorizeReferenceId = hppResult.referenceId;
    tokenData.authorizeToken = hppResult.token;
    paymentTokens.set(token, tokenData);

    console.log(`✅ Referencia Authorize.Net guardada: ${hppResult.referenceId}`);

    res.json({
      success: true,
      postUrl: hppResult.postUrl,
      token: hppResult.token,
      referenceId: hppResult.referenceId,
      message: "Link de pago Authorize.Net generado exitosamente"
    });

  } catch (error) {
    console.error("❌ Error generando link Authorize.Net:", error.message);
    
    res.status(500).json({
      success: false,
      error: error.message || "Error al generar el link de pago"
    });
  }
});

// =====================================
// API PARA ENVIAR EMAIL CON LINK DE PAGO
// =====================================
app.post("/api/send-payment-email", async (req, res) => {
  console.log("📧 SOLICITUD DE ENVÍO DE EMAIL");

  try {
    const { entityId, entityType, clientEmail, clientName } = req.body;

    if (!entityId || !clientEmail) {
      return res.status(400).json({
        success: false,
        error: "Datos incompletos para enviar email"
      });
    }

    // Generar token para el email
    const token = generateSecureToken();
    const tokenData = {
      entityId,
      entityType,
      contactEmail: clientEmail,
      contactName: clientName,
      timestamp: Date.now(),
      expires: Date.now() + (24 * 60 * 60 * 1000)
    };

    paymentTokens.set(token, tokenData);

    const paymentLink = `${BASE_URL}/payment/${token}`;

    // Enviar email
    await sendPaymentEmail(clientEmail, clientName, paymentLink, entityId);

    res.json({
      success: true,
      message: "Email enviado exitosamente",
      clientEmail: clientEmail,
      clientName: clientName,
      entityId: entityId
    });

  } catch (error) {
    console.error("❌ Error enviando email:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar el email",
      details: error.message
    });
  }
});

// =====================================
// API PARA PROCESAR PAGOS CON AUTHORIZE.NET (flujo directo)
// =====================================
app.post("/api/process-payment", async (req, res) => {
  console.log("💳 PROCESANDO PAGO CON AUTHORIZE.NET (INTEGRACIÓN REAL)");

  try {
    const { token, amount, cardNumber, expiry, cvv, cardName } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token no proporcionado"
      });
    }

    const tokenData = paymentTokens.get(token);

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        error: "Token inválido o expirado"
      });
    }

    console.log('🔄 Iniciando procesamiento con Authorize.Net para:', {
      client: tokenData.contactName,
      email: tokenData.contactEmail,
      amount: amount,
      entity: `${tokenData.entityType}-${tokenData.entityId}`
    });

    const authResult = await authorizeService.createTransaction(amount, {
      cardNumber: cardNumber,
      expiry: expiry,
      cvv: cvv,
      cardName: cardName,
      customerName: tokenData.contactName,
      customerEmail: tokenData.contactEmail,
      entityId: tokenData.entityId,
      entityType: tokenData.entityType
    });

    console.log('✅ Authorize.Net Result:', authResult);

    // Enviar email de confirmación
    await sendPaymentConfirmation(tokenData.contactEmail, {
      clientName: tokenData.contactName,
      amount: amount,
      transactionId: authResult.transactionId,
      authCode: authResult.authCode,
      referenceId: authResult.referenceId,
      entityType: tokenData.entityType,
      entityId: tokenData.entityId,
      processor: 'Authorize.Net'
    });

    // Actualizar Bitrix24 (si falla, no bloquea la respuesta)
    try {
      await bitrix24.updateDeal(tokenData.entityId, {
        UF_CRM_PAYMENT_STATUS: 'completed',
        UF_CRM_PAYMENT_AMOUNT: amount,
        UF_CRM_PAYMENT_DATE: new Date().toISOString(),
        UF_CRM_TRANSACTION_ID: authResult.transactionId,
        UF_CRM_AUTH_CODE: authResult.authCode,
        UF_CRM_REFERENCE_ID: authResult.referenceId,
        UF_CRM_PAYMENT_PROCESSOR: 'Authorize.Net',
        UF_CRM_INVOICE_NUMBER: authResult.invoiceNumber
      });
      console.log(`✅ Bitrix24 actualizado para deal ${tokenData.entityId}`);
    } catch (bitrixError) {
      console.error('❌ Error actualizando Bitrix24:', bitrixError.message);
    }

    // Limpiar token usado
    paymentTokens.delete(token);

    res.json({
      success: true,
      message: "Pago procesado exitosamente con Authorize.Net",
      transactionId: authResult.transactionId,
      authCode: authResult.authCode,
      referenceId: authResult.referenceId,
      amount: amount,
      clientEmail: tokenData.contactEmail,
      authResponse: authResult.fullResponse
    });

  } catch (error) {
    console.error("❌ Error procesando pago con Authorize.Net:", error.message);

    // Mantener el token para reintentos
    res.status(500).json({
      success: false,
      error: "Error al procesar el pago con Authorize.Net",
      details: error.message
    });
  }
});

// =====================================
// WEBHOOK SILENT POST DE AUTHORIZE.NET
// =====================================
app.post("/api/authorize-webhook", async (req, res) => {
  console.log("🔔 AUTHORIZE.NET SILENT POST WEBHOOK RECIBIDO");
  console.log("Body:", req.body);

  try {
    const { 
      x_trans_id, 
      x_response_code, 
      x_response_reason_text,
      x_amount,
      x_invoice_num,
      x_email 
    } = req.body;

    // Validar que es una transacción real
    if (!x_trans_id) {
      console.log("❌ Webhook sin transaction ID");
      return res.status(400).send("Missing transaction ID");
    }

    console.log('📋 Datos de transacción recibidos:', {
      transactionId: x_trans_id,
      responseCode: x_response_code,
      reason: x_response_reason_text,
      amount: x_amount,
      invoice: x_invoice_num,
      email: x_email
    });

    // Procesar según el código de respuesta
    if (x_response_code === '1') {
      console.log('✅ Transacción APROBADA via webhook');
      // Aquí actualizar Bitrix24, enviar email, etc.
    } else {
      console.log('❌ Transacción DECLINADA via webhook:', x_response_reason_text);
    }

    // Authorize.Net requiere una respuesta 200 OK
    res.status(200).send("OK");

  } catch (error) {
    console.error('💥 Error procesando webhook:', error);
    res.status(500).send("Error");
  }
});

// =====================================
// CALLBACKS DE AUTHORIZE.NET - MEJORADO
// =====================================
app.get("/authorize/return", async (req, res) => {
  console.log("✅ Authorize.Net Return URL llamada (GET)");
  console.log("Query params:", req.query);

  const { transId, x_trans_id, amount, x_amount } = req.query;
  const transactionId = transId || x_trans_id;
  const transactionAmount = amount || x_amount;

  try {
    if (transactionId) {
      console.log(`🔍 Obteniendo detalles de transacción: ${transactionId}`);
      
      // Verificar estado de la transacción
      const transactionDetails = await authorizeService.getTransactionStatus(transactionId);
      console.log("📋 Detalles de transacción:", transactionDetails);

      // Buscar en paymentTokens por transactionId y actualizar Bitrix24
      for (let [token, tokenData] of paymentTokens.entries()) {
        if (tokenData.authorizeReferenceId && tokenData.authorizeReferenceId.includes(transactionId)) {
          console.log(`✅ Token encontrado para transacción ${transactionId}`);
          
          // Actualizar Bitrix24
          try {
            await bitrix24.updateDeal(tokenData.entityId, {
              UF_CRM_PAYMENT_STATUS: 'completed',
              UF_CRM_PAYMENT_AMOUNT: transactionAmount || '1.00',
              UF_CRM_PAYMENT_DATE: new Date().toISOString(),
              UF_CRM_TRANSACTION_ID: transactionId,
              UF_CRM_PAYMENT_PROCESSOR: 'Authorize.Net'
            });
            console.log(`✅ Bitrix24 actualizado para deal ${tokenData.entityId}`);
          } catch (bitrixError) {
            console.error('❌ Error actualizando Bitrix24:', bitrixError.message);
          }

          // Enviar email de confirmación
          try {
            await sendPaymentConfirmation(tokenData.contactEmail, {
              clientName: tokenData.contactName,
              amount: transactionAmount || '1.00',
              transactionId: transactionId,
              entityType: tokenData.entityType,
              entityId: tokenData.entityId
            });
          } catch (emailError) {
            console.error('❌ Error enviando email:', emailError.message);
          }

          break;
        }
      }
    }

    res.redirect(`${BASE_URL}/payment-success?amount=${transactionAmount || '0'}&processor=Authorize.Net&transId=${transactionId || ''}`);
  } catch (error) {
    console.error("❌ Error en return URL:", error);
    res.redirect(`${BASE_URL}/payment-success?amount=${transactionAmount || '0'}`);
  }
});

// Agregar también POST para relay response
app.post("/authorize/return", async (req, res) => {
  console.log("✅ Authorize.Net Return URL llamada (POST)");
  console.log("Body params:", req.body);
  
  // Similar lógica al GET pero con req.body
  const { x_trans_id, x_amount } = req.body;
  
  try {
    if (x_trans_id) {
      console.log(`🔍 Procesando transacción vía POST: ${x_trans_id}`);
      // Misma lógica de actualización que en GET
    }
    
    res.redirect(`${BASE_URL}/payment-success?amount=${x_amount || '0'}&processor=Authorize.Net&transId=${x_trans_id || ''}`);
  } catch (error) {
    console.error("❌ Error en return URL (POST):", error);
    res.redirect(`${BASE_URL}/payment-success`);
  }
});

// =====================================
// RUTA DE ÉXITO DE PAGO
// =====================================
app.get("/payment-success", (req, res) => {
  const { amount, reference, processor } = req.query;

  console.log(`✅ Mostrando página de éxito para pago: $${amount}`);

  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Pago Exitoso - EG Express</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex; justify-content: center; align-items: center; 
            height: 100vh; margin: 0; padding: 20px;
        }
        .container { 
            background: white; padding: 40px; border-radius: 15px; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.1); text-align: center; 
            max-width: 500px; width: 100%;
        }
        .success-icon { font-size: 80px; color: #28a745; margin-bottom: 20px; }
        h1 { color: #28a745; margin-bottom: 15px; font-size: 32px; }
        p { color: #6c757d; margin-bottom: 20px; line-height: 1.6; font-size: 16px; }
        .receipt { 
            background: #f8f9fa; padding: 25px; border-radius: 10px; 
            margin: 25px 0; text-align: left; border-left: 4px solid #28a745;
        }
        .receipt h3 { color: #041539; margin-bottom: 15px; }
        .btn-home {
            background: linear-gradient(135deg, #007bff 0%, #0056b3 100%);
            color: white; padding: 12px 25px; border: none; border-radius: 8px;
            cursor: pointer; font-size: 16px; font-weight: 600; text-decoration: none;
            display: inline-block; margin-top: 15px;
        }
        .btn-home:hover {
            transform: translateY(-2px); box-shadow: 0 10px 20px rgba(0,123,255,0.3);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✅</div>
        <h1>¡Pago Exitoso!</h1>
        <p>El pago ha sido procesado correctamente a través de ${processor || 'Authorize.Net'}.</p>
        <p>Se ha enviado un comprobante a tu email con todos los detalles.</p>

        ${amount ? `
        <div class="receipt">
            <h3>📋 Resumen del Pago</h3>
            <p><strong>💰 Monto:</strong> $${amount}</p>
            ${reference ? `<p><strong>🔢 Referencia:</strong> ${reference}</p>` : ''}
            <p><strong>🏦 Procesador:</strong> ${processor || 'Authorize.Net'}</p>
            <p><strong>🏪 Entorno:</strong> ${authorizeService.useSandbox ? 'SANDBOX (Pruebas)' : 'PRODUCCIÓN'}</p>
            <p><strong>📅 Fecha:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>⏰ Hora:</strong> ${new Date().toLocaleTimeString()}</p>
            <p><strong>🔒 Estado:</strong> Completado</p>
        </div>
        ` : ''}

        <p style="font-size: 14px; color: #6c757d;">
            <strong>📧 Comprobante enviado a tu email</strong><br>
            Guarda este comprobante para tus registros.
        </p>

        <a href="${BASE_URL}" class="btn-home">
            🏠 Volver al Inicio
        </a>

        <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid #e9ecef;">
            <p style="font-size: 12px; color: #6c757d;">
                <strong>EG Express Payments</strong><br>
                Procesado por Authorize.Net
            </p>
        </div>
    </div>

    <script>
        // Mostrar animación de confeti después de 500ms
        setTimeout(() => {
            if (typeof confetti === 'function') {
                confetti({
                    particleCount: 100,
                    spread: 70,
                    origin: { y: 0.6 }
                });
            }
        }, 500);
    </script>

    <!-- Script de confeti opcional -->
    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js"></script>
</body>
</html>
  `);
});

// =====================================
// RUTAS PARA FALLOS Y CANCELACIONES
// =====================================
app.get("/payment-failed", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Pago Fallido - EG Express</title>
    <style>
        body { font-family: Arial, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
        .error-icon { font-size: 64px; color: #dc3545; margin-bottom: 20px; }
        h1 { color: #dc3545; margin-bottom: 15px; }
        .btn-retry { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; text-decoration: none; display: inline-block; margin-top: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">❌</div>
        <h1>Pago Fallido</h1>
        <p>El pago no pudo ser procesado. Por favor intenta nuevamente.</p>
        <a href="javascript:history.back()" class="btn-retry">🔄 Reintentar Pago</a>
    </div>
</body>
</html>
  `);
});

app.get("/payment-cancelled", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Pago Cancelado - EG Express</title>
    <style>
        body { font-family: Arial, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
        .warning-icon { font-size: 64px; color: #ffc107; margin-bottom: 20px; }
        h1 { color: #856404; margin-bottom: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="warning-icon">⚠️</div>
        <h1>Pago Cancelado</h1>
        <p>Has cancelado el proceso de pago. Puedes intentarlo nuevamente cuando lo desees.</p>
    </div>
</body>
</html>
  `);
});

// =====================================
// HEALTH CHECK MEJORADO
// =====================================
app.get("/health", (req, res) => {
  const activeSessions = Array.from(paymentTokens.entries()).map(([k, v]) => ({
    token: k.substring(0, 10) + '...',
    entity: `${v.entityType}-${v.entityId}`,
    email: v.contactEmail,
    authorizeReference: v.authorizeReferenceId || 'No asignada',
    expires: new Date(v.expires).toISOString()
  }));

  res.json({
    status: "OK",
    server: "EG Express Payments con Authorize.Net v1.0",
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    endpoints: {
      widget: "POST /widget/bitrix24",
      webhook: "POST /webhook/bitrix24", 
      health: "GET /health",
      payment: "GET /payment/:token",
      paymentSuccess: "GET /payment-success",
      sendEmail: "POST /api/send-payment-email",
      processPayment: "POST /api/process-payment",
      generateAuthorizeLink: "POST /api/generate-authorize-link",
      authorizeReturn: "GET /authorize/return",
      authorizeCancel: "GET /authorize/cancel"
    },
    authorize: {
      environment: authorizeService.useSandbox ? "SANDBOX" : "PRODUCTION",
      baseUrl: authorizeService.getBaseUrl(),
      hasApiLoginId: !!authorizeService.apiLoginId,
      hasTransactionKey: !!authorizeService.transactionKey,
      apiLoginId: authorizeService.apiLoginId ? `${authorizeService.apiLoginId.substring(0, 4)}...` : 'No configurado'
    },
    sessions: {
      active: paymentTokens.size,
      details: activeSessions
    },
    stats: {
      uptime: process.uptime(),
      memory: process.memoryUsage()
    }
  });
});

// =====================================
// RUTA DE DEBUG HPP PRODUCCIÓN
// =====================================
app.post("/api/debug-hpp-production", async (req, res) => {
  try {
    console.log('🧪 DEBUG HPP PRODUCCIÓN INICIADO');
    
    const testPayload = {
      getHostedPaymentPageRequest: {
        merchantAuthentication: {
          name: process.env.AUTHORIZE_API_LOGIN_ID,
          transactionKey: process.env.AUTHORIZE_TRANSACTION_KEY
        },
        transactionRequest: {
          transactionType: "authCaptureTransaction",
          amount: "10.00"
        }
      }
    };

    console.log('📤 DEBUG - Enviando a PRODUCCIÓN:', {
      url: 'https://api.authorize.net/xml/v1/request.api',
      payload: { ...testPayload, merchantAuthentication: { name: '***', transactionKey: '***' } }
    });

    const response = await axios.post(
      'https://api.authorize.net/xml/v1/request.api',
      testPayload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    console.log('✅ DEBUG - Respuesta PRODUCCIÓN:', JSON.stringify(response.data, null, 2));

    if (response.data.token) {
      const postUrl = 'https://accept.authorize.net/payment/payment';
      
      res.json({
        success: true,
        token: response.data.token,
        postUrl: postUrl,
        fullResponse: response.data
      });
    } else {
      throw new Error(response.data.messages?.message?.[0]?.text || 'No token received');
    }

  } catch (error) {
    console.error('💥 DEBUG - Error PRODUCCIÓN:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message,
      response: error.response?.data
    });
  }
});

// =====================================
// Ruta GET para testing del widget
// =====================================
app.get("/widget/bitrix24", (req, res) => {
  const { entityId, entityType } = req.query;
  const testEntityId = entityId || "19";
  const testEntityType = entityType || "deal";

  const html = `
    <html>
      <body style="font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5;">
        <div style="max-width: 500px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1>🧪 Testing Widget Bitrix24</h1>
          <p>Testing <strong>${testEntityType}</strong> ID: <strong>${testEntityId}</strong></p>
          <button onclick="testPost()" style="background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">
            Probar Widget POST
          </button>
          <div id="result" style="margin-top: 20px;"></div>
        </div>
        <script>
          async function testPost() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<p>⏳ Cargando widget...</p>';

            try {
              const response = await fetch('/widget/bitrix24', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  PLACEMENT_OPTIONS: JSON.stringify({ 
                    ID: '${testEntityId}'
                  }),
                  PLACEMENT: 'CRM_${testEntityType.toUpperCase()}_DETAIL_TAB'
                })
              });
              const html = await response.text();
              resultDiv.innerHTML = html;
            } catch (error) {
              resultDiv.innerHTML = '<p style="color: red;">❌ Error: ' + error.message + '</p>';
            }
          }
          // Ejecutar automáticamente
          testPost();
        </script>
      </body>
    </html>
  `;
  res.send(html);
});

// =====================================
// Ruta raíz
// =====================================
app.get("/", (req, res) => {
  res.json({
    message: "EG Express Payments API con Authorize.Net",
    version: "1.0",
    status: "running",
    baseUrl: BASE_URL,
    endpoints: {
      health: "/health",
      widget: "/widget/bitrix24",
      payment: "/payment/{token}",
      debugHpp: "/api/debug-hpp-production",
      documentation: "Ver /health para todos los endpoints"
    }
  });
});

// =====================================
// Manejo de errores global
// =====================================
app.use((err, req, res, next) => {
  console.error("💥 Error global:", err);
  res.status(500).json({
    success: false,
    error: "Error interno del servidor",
    details: err.message
  });
});

// =====================================
// Inicializar servidor
// =====================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor EG Express Payments con Authorize.Net ejecutándose en puerto ${PORT}`);
  console.log(`🔗 URL Base: ${BASE_URL}`);
  console.log(`🎯 Widget: POST ${BASE_URL}/widget/bitrix24`);
  console.log(`🔗 Webhook: POST ${BASE_URL}/webhook/bitrix24`);
  console.log(`💳 Pagos: GET ${BASE_URL}/payment/{token}`);
  console.log(`✅ Éxito: GET ${BASE_URL}/payment-success`);
  console.log(`📧 Email: POST ${BASE_URL}/api/send-payment-email`);
  console.log(`💳 Procesar: POST ${BASE_URL}/api/process-payment`);
  console.log(`🔗 Authorize Generate: POST ${BASE_URL}/api/generate-authorize-link`);
  console.log(`🔧 Debug HPP: POST ${BASE_URL}/api/debug-hpp-production`);
  console.log(`↩️  Authorize Return: GET ${BASE_URL}/authorize/return`);
  console.log(`❌ Authorize Cancel: GET ${BASE_URL}/authorize/cancel`);
  console.log(`❤️  Health: GET ${BASE_URL}/health`);
  console.log(`🏦 Authorize.Net: ${authorizeService.useSandbox ? 'SANDBOX' : 'PRODUCTION'} - ${authorizeService.getBaseUrl()}`);
});