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
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

console.log(`🔗 URL Base configurada: ${BASE_URL}`);

// CORS
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://ensurityexpress.com",
      "https://www.ensurityexpress.com",
      "https://ensurityexpress.bitrix24.com",
      BASE_URL,
    ],
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    credentials: true,
  })
);

// Middlewares
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan("combined"));

// =========================
// CONFIG SMTP (desde .env)
// =========================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "mail.ensurityexpress.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
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
// CLASE AUTHORIZE.NET SERVICE (Accept.js)
// =====================================
class AuthorizeNetService {
  constructor() {
    this.sandboxUrl = "https://apitest.authorize.net";
    this.productionUrl = "https://api.authorize.net";

    this.apiLoginId = process.env.AUTHORIZE_API_LOGIN_ID;
    this.transactionKey = process.env.AUTHORIZE_TRANSACTION_KEY;
    this.clientKey = process.env.AUTHORIZE_CLIENT_KEY;
    this.useSandbox = (process.env.AUTHORIZE_USE_SANDBOX || "false") === "true";

    // Límite típico de Authorize.Net para invoiceNumber
    this.INVOICE_MAX_LEN = 20;

    console.log("🚨 VERIFICACIÓN AUTHORIZE.NET CONFIGURACIÓN:", {
      environment: this.useSandbox ? "SANDBOX" : "PRODUCCIÓN",
      apiLoginId: this.apiLoginId
        ? `PRESENTE (${this.apiLoginId.substring(0, 4)}...)`
        : "FALTANTE",
      transactionKey: this.transactionKey ? "PRESENTE" : "FALTANTE",
      clientKey: this.clientKey ? "PRESENTE" : "FALTANTE",
      baseUrl: this.getBaseUrl(),
    });
  }

  getBaseUrl() {
    return this.useSandbox ? this.sandboxUrl : this.productionUrl;
  }

  // Generador seguro de invoiceNumber
  buildInvoiceNumber(entityId = "WEB") {
    const cleanEntity = String(entityId)
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 8);

    const base = `INV-${cleanEntity || "WEB"}`;
    const shortTs = Date.now().toString().slice(-6);
    let invoice = `${base}-${shortTs}`;

    if (invoice.length > this.INVOICE_MAX_LEN) {
      invoice = invoice.slice(0, this.INVOICE_MAX_LEN);
    }

    return invoice;
  }

  generateReferenceId() {
    return `AUTH${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
  }

  // Crear transacción usando opaqueData (Accept.js) o tarjeta directa (fallback)
  async createTransaction(amount, paymentData) {
    try {
      console.log("🔄 Creando transacción en Authorize.Net...");

      const transactionRequest = {
        transactionType: "authCaptureTransaction",
        amount: amount.toString(),
        order: {
          invoiceNumber: this.buildInvoiceNumber(paymentData.entityId),
          description: `Payment for ${paymentData.entityType} ${paymentData.entityId}`,
        },
        customer: {
          email: paymentData.customerEmail,
        },
        billTo: {
          firstName: (paymentData.customerName || "Customer").split(" ")[0],
          lastName:
            (paymentData.customerName || "Customer")
              .split(" ")
              .slice(1)
              .join(" ") || "Customer",
          email: paymentData.customerEmail,
        },
        userFields: {
          userField: [
            {
              name: "entityType",
              value: paymentData.entityType,
            },
            {
              name: "entityId",
              value: paymentData.entityId,
            },
          ],
        },
      };

      if (paymentData.opaqueData) {
        // Flujo recomendado con Accept.js
        transactionRequest.payment = {
          opaqueData: {
            dataDescriptor: paymentData.opaqueData.dataDescriptor,
            dataValue: paymentData.opaqueData.dataValue,
          },
        };
        console.log("💳 Usando opaqueData (Accept.js)");
      } else if (
        paymentData.cardNumber &&
        paymentData.expiry &&
        paymentData.cvv
      ) {
        // Fallback (no recomendado por PCI, pero lo dejamos por compatibilidad)
        transactionRequest.payment = {
          creditCard: {
            cardNumber: paymentData.cardNumber,
            expirationDate: paymentData.expiry,
            cardCode: paymentData.cvv,
          },
        };
        console.log("⚠️ Usando tarjeta directa (fallback, no recomendado)");
      } else {
        throw new Error(
          "No se proporcionó opaqueData ni datos de tarjeta para la transacción"
        );
      }

      const payload = {
        createTransactionRequest: {
          merchantAuthentication: {
            name: this.apiLoginId,
            transactionKey: this.transactionKey,
          },
          transactionRequest,
        },
      };

      console.log("📤 Enviando request a Authorize.Net:", {
        url: `${this.getBaseUrl()}/xml/v1/request.api`,
        payload: {
          ...payload,
          createTransactionRequest: {
            ...payload.createTransactionRequest,
            merchantAuthentication: {
              name: "***",
              transactionKey: "***",
            },
          },
        },
      });

      const response = await axios.post(
        `${this.getBaseUrl()}/xml/v1/request.api`,
        payload,
        {
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
        }
      );

      console.log("✅ Respuesta de Authorize.Net:", response.data);

      const result = response.data;
      const transactionResponse = result.transactionResponse;

      if (transactionResponse && transactionResponse.responseCode === "1") {
        return {
          success: true,
          transactionId: transactionResponse.transId,
          authCode: transactionResponse.authCode,
          referenceId: this.generateReferenceId(),
          invoiceNumber:
            payload.createTransactionRequest.transactionRequest.order
              .invoiceNumber,
          cardData: {
            accountNumber: transactionResponse.accountNumber,
            accountType: transactionResponse.accountType,
          },
          fullResponse: result,
        };
      } else {
        const errorMsg =
          transactionResponse?.errors?.error?.[0]?.errorText ||
          result.messages?.message?.[0]?.text ||
          "Transacción fallida en Authorize.Net";
        throw new Error(errorMsg);
      }
    } catch (error) {
      console.error("❌ Error procesando transacción con Authorize.Net:", {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });

      const errorMessage =
        error.response?.data?.messages?.message?.[0]?.text ||
        error.response?.data?.transactionResponse?.errors?.error?.[0]
          ?.errorText ||
        error.message;

      throw new Error(errorMessage);
    }
  }

  // Verificar estado de transacción
  async getTransactionStatus(transactionId) {
    try {
      const payload = {
        getTransactionDetailsRequest: {
          merchantAuthentication: {
            name: this.apiLoginId,
            transactionKey: this.transactionKey,
          },
          transId: transactionId,
        },
      };

      const response = await axios.post(
        `${this.getBaseUrl()}/xml/v1/request.api`,
        payload,
        { headers: { "Content-Type": "application/json" } }
      );

      return response.data;
    } catch (error) {
      console.error(
        "❌ Error verificando transacción:",
        error.response?.data || error.message
      );
      throw error;
    }
  }
}

// =====================================
// CLASE Bitrix24
// =====================================
class Bitrix24 {
  constructor() {
    this.webhookUrl =
      process.env.BITRIX24_WEBHOOK_URL ||
      "https://ensurityexpress.bitrix24.com/rest/65/v6hyou7s4l7fpj5l";
  }

  async getDeal(dealId) {
    try {
      console.log(`🔍 Obteniendo deal ${dealId}...`);
      const response = await axios.get(`${this.webhookUrl}/crm.deal.get`, {
        params: { id: dealId },
      });

      if (response.data.result) {
        console.log(`✅ Deal obtenido:`, {
          title: response.data.result.TITLE,
          contactId: response.data.result.CONTACT_ID,
          stageId: response.data.result.STAGE_ID,
          amount: response.data.result.OPPORTUNITY,
        });
        return response.data.result;
      } else {
        console.log("❌ Deal no encontrado");
        return null;
      }
    } catch (error) {
      console.error("❌ Error obteniendo deal:", error.message);
      throw error;
    }
  }

  async getContactFromDeal(dealId) {
    try {
      console.log(`🔍 Obteniendo contacto desde deal ${dealId}...`);
      const deal = await this.getDeal(dealId);

      if (deal && deal.CONTACT_ID && deal.CONTACT_ID !== "0") {
        console.log(
          `✅ Deal tiene contacto asociado: ${deal.CONTACT_ID}`
        );
        const contact = await this.getContact(deal.CONTACT_ID);
        return contact;
      } else {
        console.log("❌ Deal no tiene contacto asociado válido");
        return null;
      }
    } catch (error) {
      console.error(
        "❌ Error obteniendo contacto desde deal:",
        error.message
      );
      return null;
    }
  }

  async getContact(contactId) {
    try {
      console.log(`🔍 Obteniendo contacto ${contactId}...`);
      const response = await axios.get(`${this.webhookUrl}/crm.contact.get`, {
        params: { id: contactId },
      });

      if (response.data.result) {
        console.log(`✅ Contacto obtenido:`, {
          name: `${response.data.result.NAME || ""} ${
            response.data.result.LAST_NAME || ""
          }`,
          email: response.data.result.EMAIL?.[0]?.VALUE || "No disponible",
          phone: response.data.result.PHONE?.[0]?.VALUE || "No disponible",
        });
      }

      return response.data.result;
    } catch (error) {
      console.error("❌ Error obteniendo contacto:", error.message);
      throw error;
    }
  }

  async updateDeal(dealId, data) {
    try {
      console.log(`🔄 Actualizando deal ${dealId}...`);
      const response = await axios.post(
        `${this.webhookUrl}/crm.deal.update`,
        {
          id: dealId,
          fields: data,
        }
      );
      console.log(`✅ Deal actualizado exitosamente`);
      return response.data.result;
    } catch (error) {
      console.error("❌ Error actualizando deal:", error.message);
      throw error;
    }
  }
}

// Inicializar servicios
const authorizeService = new AuthorizeNetService();
const bitrix24 = new Bitrix24();

// Generar token seguro
function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ================================
// FUNCIONES DE EMAIL
// ================================
async function sendPaymentEmail(
  email,
  clientName,
  paymentLink,
  dealId,
  amount = null
) {
  try {
    let dealAmount = amount;
    if (!dealAmount && dealId) {
      try {
        const deal = await bitrix24.getDeal(dealId);
        dealAmount = deal?.OPPORTUNITY || "20.80";
      } catch (error) {
        console.error("Error obteniendo monto del deal:", error);
        dealAmount = "20.80";
      }
    } else if (!dealAmount) {
      dealAmount = "20.80";
    }

    const mailOptions = {
      from: `"Ensurity Express Payments" <${
        process.env.SMTP_USER || "invoice@ensurityexpress.com"
      }>`,
      to: email,
      subject: `Link de Pago - Deal #${dealId}`,
      html: `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background: #f4f4f4; }
        .header { background: linear-gradient(90deg, #af100a 0%, #5b0000 100%); color: white; padding: 24px 30px; text-align: left; border-radius: 12px 12px 0 0; }
        .header h1 { margin: 0; font-size: 24px; }
        .header p { margin: 5px 0 0 0; font-size: 14px; opacity: 0.95; }
        .content { background: #ffffff; padding: 24px 30px 30px 30px; border-radius: 0 0 12px 12px; border: 1px solid #e0e0e0; border-top: none; }
        .payment-link { background: linear-gradient(90deg, #af100a 0%, #5b0000 100%); color: white; padding: 14px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0; font-weight: bold; font-size: 15px; }
        .payment-link:hover { opacity: 0.9; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; text-align: center; }
        .amount-info { background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 15px 0; border-left: 4px solid #af100a; }
        .brand { font-weight: 700; color: #af100a; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Ensurity Express Payments</h1>
        <p>Sistema de Pagos Seguro con Authorize.Net</p>
    </div>

    <div class="content">
        <p>Hola <strong>${clientName}</strong>,</p>
        <p>Has recibido un link de pago seguro para completar tu transacción con <span class="brand">Ensurity Express</span>.</p>

        <div class="amount-info">
            <p><strong>Referencia:</strong> Deal #${dealId}</p>
            <p><strong>Monto a pagar (sugerido):</strong> <strong>$${dealAmount} USD</strong></p>
        </div>

        <p>Para completar tu pago, haz clic en el siguiente botón. Serás enviado a nuestro portal de pago seguro:</p>

        <div style="text-align: center; margin: 24px 0;">
            <a href="${paymentLink}" class="payment-link" target="_blank">
                💳 Ir al Pago Seguro
            </a>
        </div>

        <p><strong>Importante:</strong></p>
        <ul>
            <li>Este link es válido por 24 horas.</li>
            <li>El pago se procesa a través de Authorize.Net en un entorno cifrado.</li>
        </ul>

        <p>Si tienes alguna pregunta, por favor contáctanos.</p>
    </div>

    <div class="footer">
        <p>Ensurity Express Payments System<br>
        <small>Este es un email automático, por favor no respondas a este mensaje.</small></p>
    </div>
</body>
</html>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(
      `✅ Email enviado a: ${email} con monto sugerido: $${dealAmount}`
    );
    return info;
  } catch (error) {
    console.error("❌ Error enviando email:", error);
    throw error;
  }
}

async function sendPaymentConfirmation(email, paymentData) {
  try {
    const mailOptions = {
      from: `"Ensurity Express Payments" <${
        process.env.SMTP_USER || "invoice@ensurityexpress.com"
      }>`,
      to: email,
      subject: `✅ Confirmación de Pago - ${paymentData.transactionId}`,
      html: `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background: #f4f4f4; }
        .header { background: linear-gradient(90deg, #af100a 0%, #5b0000 100%); color: white; padding: 30px; text-align: left; border-radius: 10px 10px 0 0; }
        .content { background: #ffffff; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e0e0e0; border-top: none; }
        .receipt { background: #f8f9fa; padding: 20px; border-radius: 5px; border-left: 4px solid #af100a; margin: 20px 0; }
        .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; text-align: center; }
    </style>
</head>
<body>
    <div class="header">
        <h1>✅ Pago Confirmado</h1>
        <p>Ensurity Express Payments</p>
    </div>

    <div class="content">
        <h2>Hola ${paymentData.clientName},</h2>
        <p>Tu pago ha sido procesado exitosamente a través de Authorize.Net.</p>

        <div class="receipt">
            <h3>📋 Comprobante de Pago</h3>
            <p><strong>Monto:</strong> $${paymentData.amount}</p>
            <p><strong>ID de Transacción:</strong> ${paymentData.transactionId}</p>
            <p><strong>Código de Autorización:</strong> ${
              paymentData.authCode || "N/A"
            }</p>
            <p><strong>Referencia:</strong> ${
              paymentData.referenceId || paymentData.transactionId
            }</p>
            <p><strong>Procesador:</strong> Authorize.Net</p>
            <p><strong>Fecha:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Hora:</strong> ${new Date().toLocaleTimeString()}</p>
        </div>

        <p>Hemos registrado tu pago en nuestro sistema. Este comprobante sirve como recibo oficial.</p>

        <p><strong>Gracias por confiar en Ensurity Express.</strong></p>
    </div>

    <div class="footer">
        <p>Ensurity Express Payments System<br>
        <small>Este es un email automático, por favor no respondas a este mensaje.</small></p>
    </div>
</body>
</html>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email de confirmación enviado a: ${email}`);
    return info;
  } catch (error) {
    console.error("❌ Error enviando email de confirmación:", error);
    throw error;
  }
}

// =====================================
// COMUNICADOR IFRAME (no estrictamente necesario con Accept.js, lo dejamos)
// =====================================
app.get("/iframe-communicator", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Ensurity Express - Comunicador de Pago</title>
    <script type="text/javascript">
        function callParentFunction(str) {
            if (parent && parent.message) {
                parent.message(str);
            }
        }
        
        function receiveMessage(event) {
            if (event.data === "resize") {
                callParentFunction("resize");
            }
        }
        
        window.addEventListener("message", receiveMessage, false);
        
        if (window.parent !== window) {
            window.parent.postMessage("iframeReady", "*");
        }
    </script>
</head>
<body>
    <p>Comunicador de pago Ensurity Express</p>
</body>
</html>
  `);
});

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
    let dealAmount = null;

    if (PLACEMENT_OPTIONS) {
      let options;

      if (typeof PLACEMENT_OPTIONS === "string") {
        options = JSON.parse(PLACEMENT_OPTIONS);
      } else {
        options = PLACEMENT_OPTIONS;
      }

      entityId = options.ID;

      if (PLACEMENT === "CRM_CONTACT_DETAIL_TAB") {
        entityType = "contact";
        console.log(`👤 Es un CONTACTO: ${entityId}`);
        contactData = await bitrix24.getContact(entityId);
      } else if (PLACEMENT === "CRM_DEAL_DETAIL_TAB") {
        entityType = "deal";
        console.log(`💼 Es un DEAL: ${entityId}`);
        contactData = await bitrix24.getContactFromDeal(entityId);

        const deal = await bitrix24.getDeal(entityId);
        dealAmount = deal?.OPPORTUNITY || "20.80";
        console.log(`💰 Monto del deal: $${dealAmount}`);

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
            <title>Ensurity Express Payments</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f4f4; padding: 0; margin: 0; }
                .widget-container { width: 100%; background: #ffffff; border-radius: 0; border-top: 4px solid #af100a; }
                .header { background: linear-gradient(90deg, #af100a 0%, #5b0000 100%); color: white; padding: 14px 18px; text-align: left; }
                .header h2 { margin: 0; font-size: 18px; }
                .header p { margin: 4px 0 0 0; font-size: 12px; opacity: 0.95; }
                .content { padding: 16px 18px 18px 18px; }
                .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; text-align: left; }
                .warning h3 { margin-bottom: 8px; font-size: 15px; }
                .btn { background: linear-gradient(90deg, #af100a 0%, #5b0000 100%); color: white; padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; margin: 4px 0; width: 100%; font-size: 14px; font-weight: 600; }
                .btn:hover { opacity: 0.95; }
                #result { font-size: 12px; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div class="widget-container">
                <div class="header">
                    <h2>Ensurity Express Payments</h2>
                    <p>Sistema de pagos con Authorize.Net</p>
                </div>
                <div class="content">
                    <div class="warning">
                        <h3>⚠️ Información requerida</h3>
                        <p>Este ${entityType} no tiene un contacto asociado válido.</p>
                        <p>Por favor asigna un contacto al ${entityType} para poder generar links de pago.</p>
                    </div>
                    <button class="btn" onclick="testConnection()">
                        🔗 Probar conexión
                    </button>
                    <div id="result"></div>
                </div>
            </div>
            <script>
                async function testConnection() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = '⏳ Probando conexión...';
                    try {
                        const response = await fetch('${BASE_URL}/health');
                        const result = await response.json();
                        resultDiv.innerHTML = '✅ Conexión exitosa con el servidor';
                    } catch (error) {
                        resultDiv.innerHTML = '❌ Error de conexión';
                    }
                }
            </script>
        </body>
        </html>
      `;
    } else {
      const clientEmail =
        contactData?.EMAIL?.[0]?.VALUE || "No disponible";
      const clientName = contactData
        ? `${contactData.NAME || ""} ${
            contactData.LAST_NAME || ""
          }`.trim()
        : "Cliente no disponible";
      const clientPhone =
        contactData?.PHONE?.[0]?.VALUE || "No disponible";

      widgetHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>Ensurity Express Payments</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
        .widget-container { width: 100%; background: #ffffff; border-radius: 0; border-top: 4px solid #af100a; }
        .header { background: linear-gradient(90deg, #af100a 0%, #5b0000 100%); color: white; padding: 14px 18px; text-align: left; }
        .header h2 { margin: 0; font-size: 18px; font-weight: 600; }
        .header p { margin: 4px 0 0 0; opacity: 0.95; font-size: 12px; }
        .content { padding: 16px 18px 18px 18px; }
        .client-info { background: #f8f9fa; padding: 14px; border-radius: 8px; margin-bottom: 14px; border-left: 4px solid #af100a; font-size: 13px; }
        .client-info h3 { color: #af100a; margin-bottom: 10px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
        .info-item { display: flex; align-items: center; margin-bottom: 4px; }
        .info-icon { width: 18px; text-align: center; margin-right: 8px; color: #af100a; }
        .btn { background: linear-gradient(90deg, #af100a 0%, #5b0000 100%); color: white; padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; margin: 5px 0; width: 100%; font-size: 14px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .btn:hover { opacity: 0.95; }
        .btn-success { background: linear-gradient(90deg, #008f39 0%, #00692a 100%); }
        .btn-secondary { background: #343a40; }
        .result { margin-top: 12px; padding: 12px; border-radius: 8px; background: #ffffff; border: 2px solid transparent; font-size: 12px; }
        .success { border-color: #af100a; background: #f8fff9; }
        .error { border-color: #dc3545; background: #fff5f5; }
        .link-display { word-break: break-all; padding: 10px; background: #e9ecef; border-radius: 6px; margin: 10px 0; font-size: 12px; border: 1px dashed #6c757d; }
        .loading { display: inline-block; width: 18px; height: 18px; border: 3px solid #f3f3f3; border-top: 3px solid #af100a; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .email-section { background: #ffeaea; padding: 10px; border-radius: 6px; margin: 10px 0; border: 1px solid #ffcdd2; }
        .amount-info { background: #f8f9fa; padding: 8px; border-radius: 5px; margin: 8px 0; border-left: 3px solid #af100a; }
    </style>
</head>
<body>
    <div class="widget-container">
        <div class="header">
            <h2>Ensurity Express Payments</h2>
            <p>Sistema de pagos con Authorize.Net (Accept.js)</p>
        </div>

        <div class="content">
            <div class="client-info">
                <h3>👤 Información del cliente</h3>
                <div class="info-item">
                    <span class="info-icon">👤</span>
                    <span><strong>Nombre:</strong> ${clientName}</span>
                </div>
                <div class="info-item">
                    <span class="info-icon">📧</span>
                    <span><strong>Email:</strong> ${clientEmail}</span>
                </div>
                <div class="info-item">
                    <span class="info-icon">📞</span>
                    <span><strong>Teléfono:</strong> ${clientPhone}</span>
                </div>
                <div class="info-item">
                    <span class="info-icon">🆔</span>
                    <span><strong>ID:</strong> ${entityId} (${entityType})</span>
                </div>
                ${
                  dealAmount
                    ? `
                <div class="amount-info">
                    <div class="info-item">
                        <span class="info-icon">💰</span>
                        <span><strong>Monto del deal (sugerido):</strong> $${dealAmount} USD</span>
                    </div>
                </div>
                `
                    : ""
                }
            </div>

            <button class="btn" onclick="generatePaymentLink()">
                🎯 Generar link de pago (formulario propio)
            </button>

            <button class="btn btn-success" onclick="sendPaymentEmailToClient()">
                📧 Enviar link por email
            </button>

            <button class="btn btn-secondary" onclick="testConnection()">
                🔗 Probar conexión
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
        const DEAL_AMOUNT = '${dealAmount || "20.80"}';

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
                            CONTACT_NAME: CLIENT_NAME,
                            DEAL_AMOUNT: DEAL_AMOUNT
                        })
                    })
                });

                const result = await response.json();

                if (result.success) {
                    resultDiv.innerHTML =
                        '<div style="color: #af100a; text-align: center;">' +
                        '✅ <strong>Link generado exitosamente</strong></div><br>' +
                        '<strong>🔗 Enlace de pago seguro:</strong><br>' +
                        '<div class="link-display">' + result.paymentLink + '</div><br>' +
                        '<button class="btn" onclick="copyToClipboard(\\'' + result.paymentLink + '\\')">📋 Copiar link</button>' +
                        '<div style="margin-top: 10px; padding: 8px; background: #ffeaea; border-radius: 5px; font-size: 11px; color: #af100a;">' +
                        '💡 Envía este link al cliente para que complete el pago en nuestro formulario seguro.' +
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
                        clientName: CLIENT_NAME,
                        amount: DEAL_AMOUNT
                    })
                });

                const result = await response.json();

                if (result.success) {
                    resultDiv.innerHTML =
                        '<div style="color: #af100a; text-align: center;">' +
                        '✅ <strong>Email enviado exitosamente</strong></div><br>' +
                        '<div class="email-section">' +
                        '<strong>📧 Destinatario:</strong> ' + CLIENT_EMAIL + '<br>' +
                        '<strong>👤 Cliente:</strong> ' + CLIENT_NAME + '<br>' +
                        '<strong>💰 Monto sugerido:</strong> $' + DEAL_AMOUNT + ' USD<br>' +
                        '<strong>🆔 Referencia:</strong> ' + ENTITY_TYPE + '-' + ENTITY_ID +
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
                    '<div style="color: #af100a; text-align: center;">' +
                    '✅ <strong>Conexión exitosa</strong></div><br>' +
                    '<div style="text-align: left; font-size: 11px;">' +
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
        <button style="padding: 10px 20px; background: #af100a; color: white; border: none; border-radius: 5px; cursor: pointer;" 
                onclick="location.reload()">🔄 Reintentar</button>
      </div>
    `);
  }
});

// =====================================
// WEBHOOK PARA GENERAR LINKS DE PAGO (formulario propio Accept.js)
// =====================================
app.post("/webhook/bitrix24", async (req, res) => {
  console.log("🔗 WEBHOOK BITRIX24 LLAMADO");
  console.log("Body:", req.body);

  try {
    const { PLACEMENT_OPTIONS } = req.body;

    if (!PLACEMENT_OPTIONS) {
      return res.status(400).json({
        success: false,
        error: "PLACEMENT_OPTIONS no encontrado",
      });
    }

    let options;
    try {
      options =
        typeof PLACEMENT_OPTIONS === "string"
          ? JSON.parse(PLACEMENT_OPTIONS)
          : PLACEMENT_OPTIONS;
    } catch (parseError) {
      return res.status(400).json({
        success: false,
        error: "PLACEMENT_OPTIONS no es un JSON válido",
      });
    }

    const entityId = options.ENTITY_ID;
    const entityType = options.ENTITY_TYPE;
    const contactEmail = options.CONTACT_EMAIL;
    const contactName = options.CONTACT_NAME;
    const dealAmount = options.DEAL_AMOUNT;

    if (!entityId) {
      return res.status(400).json({
        success: false,
        error: "Entity ID no encontrado",
      });
    }

    const token = generateSecureToken();
    const tokenData = {
      entityId,
      entityType,
      contactEmail,
      contactName,
      dealAmount: dealAmount || null,
      timestamp: Date.now(),
      expires: Date.now() + 24 * 60 * 60 * 1000,
      flowType: "direct_link",
    };

    paymentTokens.set(token, tokenData);
    console.log(
      `✅ Token generado para ${entityType} ${entityId} - Flujo: Link Directo`
    );

    const paymentLink = `${BASE_URL}/payment/${token}`;

    res.json({
      success: true,
      paymentLink: paymentLink,
      entityId: entityId,
      entityType: entityType,
      contactEmail: contactEmail,
      flowType: "direct_link",
      message:
        "Link de pago generado exitosamente - Cliente paga en formulario Ensurity (Accept.js)",
    });
  } catch (error) {
    console.error("❌ Error en webhook:", error);
    res.status(500).json({
      success: false,
      error: "Error al procesar la solicitud",
    });
  }
});

// =====================================
// RUTA DE PAGO CON TOKEN (FORMULARIO Accept.js)
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
            <title>Link Inválido - Ensurity Express</title>
            <style>
                body { font-family: Arial, sans-serif; background: #f4f4f4; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                .error-icon { font-size: 64px; color: #af100a; margin-bottom: 20px; }
                h1 { color: #af100a; margin-bottom: 15px; }
                p { color: #6c757d; margin-bottom: 20px; line-height: 1.6; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="error-icon">❌</div>
                <h1>Link inválido o expirado</h1>
                <p>Este link de pago ha expirado o es inválido.</p>
                <p>Por favor solicita un nuevo link de pago al agente.</p>
            </div>
        </body>
        </html>
      `);
    }

    if (Date.now() > tokenData.expires) {
      paymentTokens.delete(token);
      console.log("⏰ Token expirado");
      return res.status(410).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Link Expirado - Ensurity Express</title>
            <style>
                body { font-family: Arial, sans-serif; background: #f4f4f4; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
                .error-icon { font-size: 64px; color: #ffc107; margin-bottom: 20px; }
                h1 { color: #856404; margin-bottom: 15px; }
                p { color: #6c757d; margin-bottom: 20px; line-height: 1.6; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="error-icon">⏰</div>
                <h1>Link expirado</h1>
                <p>Este link de pago ha expirado.</p>
                <p>Por favor solicita un nuevo link al agente.</p>
            </div>
        </body>
        </html>
      `);
    }

    console.log(
      `✅ Token válido para: ${tokenData.contactName} (${tokenData.contactEmail}) - Flujo: ${tokenData.flowType}`
    );

    const defaultAmount = tokenData.dealAmount || "20.80";

    const apiLoginIdSafe = authorizeService.apiLoginId || "";
    const clientKeySafe = authorizeService.clientKey || "";

    const paymentForm = `
<!DOCTYPE html>
<html>
<head>
    <title>Ensurity Express - Portal de Pagos Seguro (Accept.js)</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #f4f4f4;
            margin: 0; padding: 20px;
            min-height: 100vh;
            display: flex; align-items: center; justify-content: center;
        }
        .payment-container {
            background: white; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            overflow: hidden; width: 100%; max-width: 500px;
        }
        .payment-header {
            background: linear-gradient(90deg, #af100a 0%, #5b0000 100%);
            color: white; padding: 22px 26px;
            text-align: left; border-bottom: 4px solid #000000;
        }
        .payment-header h1 { margin: 0; font-size: 22px; font-weight: 600; }
        .payment-header p { margin: 6px 0 0 0; font-size: 13px; opacity: 0.95; }
        .payment-content { padding: 22px 26px 26px 26px; }
        .client-summary {
            background: #f8f9fa; padding: 16px; border-radius: 10px; margin-bottom: 18px;
            border-left: 4px solid #af100a; font-size: 13px;
        }
        .form-group { margin-bottom: 16px; }
        .form-group label {
            display: block; margin-bottom: 6px; font-weight: 600; color: #af100a; font-size: 13px;
        }
        .form-group input {
            width: 100%; padding: 10px 12px; border: 2px solid #e9ecef; border-radius: 8px;
            font-size: 14px; transition: border-color 0.3s ease;
        }
        .form-group input:focus {
            outline: none; border-color: #af100a; box-shadow: 0 0 0 3px rgba(175, 16, 10, 0.1);
        }
        .form-row {
            display: flex;
            gap: 8px;
        }
        .form-row .form-group {
            flex: 1;
        }
        .btn-pay {
            background: linear-gradient(90deg, #af100a 0%, #5b0000 100%);
            color: white; border: none; padding: 13px 20px; border-radius: 8px;
            font-size: 16px; font-weight: 600; width: 100%; cursor: pointer;
            transition: all 0.3s ease; display: flex; align-items: center;
            justify-content: center; gap: 8px; margin-top: 8px;
        }
        .btn-pay:hover:not(:disabled) {
            transform: translateY(-2px); box-shadow: 0 10px 20px rgba(175, 16, 10, 0.3);
        }
        .btn-pay:disabled {
            background: #6c757d; cursor: not-allowed; opacity: 0.7;
        }
        .security-notice {
            background: #ffeaea; padding: 12px; border-radius: 8px; margin-top: 16px;
            text-align: center; font-size: 12px; color: #af100a; border: 1px solid #ffcdd2;
        }
        .loading { 
            display: inline-block; width: 20px; height: 20px; 
            border: 3px solid #f3f3f3; border-top: 3px solid #000000; 
            border-radius: 50%; animation: spin 1s linear infinite; 
        }
        @keyframes spin { 
            0% { transform: rotate(0deg); } 
            100% { transform: rotate(360deg); } 
        }
        .result-message { 
            padding: 12px; border-radius: 8px; margin: 12px 0; text-align: center; 
            display: none; font-size: 13px;
        }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .flow-indicator {
            background: #af100a; color: white; padding: 6px 12px; border-radius: 20px;
            font-size: 11px; font-weight: bold; display: inline-block; margin-bottom: 12px;
        }
        .field-note {
            font-size: 11px; color: #6c757d; margin-top: 4px;
        }
    </style>
    <script type="text/javascript"
      src="https://js.authorize.net/v3/Accept.js">
    </script>
</head>
<body>
    <div class="payment-container">
        <div class="payment-header">
            <h1>Portal de pagos seguro</h1>
            <p>Ensurity Express · Procesado con Authorize.Net (Accept.js)</p>
        </div>

        <div class="payment-content">
            <div class="flow-indicator">
                💳 FORMULARIO ENSURITY · TOKENIZADO CON ACCEPT.JS
            </div>

            <div class="client-summary">
                <p><strong>👤 Cliente:</strong> ${tokenData.contactName}</p>
                <p><strong>📧 Email:</strong> ${tokenData.contactEmail}</p>
                <p><strong>🆔 Referencia:</strong> ${(tokenData.entityType || "DEAL").toUpperCase()}-${tokenData.entityId}</p>
                <p><strong>💰 Monto sugerido:</strong> $${defaultAmount} USD</p>
                <p><strong>🏦 Entorno:</strong> ${
                  authorizeService.useSandbox ? "SANDBOX (Pruebas)" : "PRODUCCIÓN"
                }</p>
            </div>

            <form id="paymentForm">
                <div class="form-group">
                    <label for="amount">💵 Monto a pagar (USD)</label>
                    <input type="number" id="amount" name="amount"
                           placeholder="0.00" min="1" step="0.01"
                           value="${defaultAmount}" required>
                    <div class="field-note">
                        💡 Puedes ajustar el monto si es necesario.
                    </div>
                </div>

                <div class="form-group">
                    <label for="cardNumber">💳 Número de tarjeta</label>
                    <input type="text" id="cardNumber" maxlength="19" autocomplete="off" placeholder="4111 1111 1111 1111" required>
                </div>

                <div class="form-row">
                    <div class="form-group">
                        <label for="expMonth">Mes (MM)</label>
                        <input type="text" id="expMonth" maxlength="2" autocomplete="off" placeholder="12" required>
                    </div>
                    <div class="form-group">
                        <label for="expYear">Año (YYYY)</label>
                        <input type="text" id="expYear" maxlength="4" autocomplete="off" placeholder="2027" required>
                    </div>
                    <div class="form-group">
                        <label for="cardCode">CVV</label>
                        <input type="password" id="cardCode" maxlength="4" autocomplete="off" placeholder="123" required>
                    </div>
                </div>

                <div class="form-group">
                    <label for="cardName">Nombre en la tarjeta</label>
                    <input type="text" id="cardName" autocomplete="off" placeholder="Nombre y apellido" required>
                </div>

                <button type="submit" class="btn-pay" id="submitBtn">
                    <span id="btnText">🚀 Procesar pago seguro</span>
                    <div id="btnLoading" class="loading" style="display: none;"></div>
                </button>
            </form>

            <div id="resultMessage" class="result-message"></div>

            <div class="security-notice">
                🔒 Tus datos de tarjeta se tokenizan con Accept.js de Authorize.Net.
                Nuestro servidor solo recibe un token seguro (opaqueData), no el número de tarjeta.
            </div>
        </div>
    </div>

    <script>
        const TOKEN = '${token}';
        const SERVER_URL = '${BASE_URL}';
        const API_LOGIN_ID = '${apiLoginIdSafe}';
        const CLIENT_KEY = '${clientKeySafe}';

        const paymentForm = document.getElementById('paymentForm');
        const submitBtn = document.getElementById('submitBtn');
        const btnText = document.getElementById('btnText');
        const btnLoading = document.getElementById('btnLoading');
        const resultMessage = document.getElementById('resultMessage');

        function setLoading(isLoading) {
            submitBtn.disabled = isLoading;
            btnText.style.display = isLoading ? 'none' : 'inline';
            btnLoading.style.display = isLoading ? 'inline-block' : 'none';
        }

        function showMessage(type, html) {
            resultMessage.innerHTML = html;
            resultMessage.className = 'result-message ' + type;
            resultMessage.style.display = 'block';
        }

        paymentForm.addEventListener('submit', function (e) {
            e.preventDefault();

            if (!API_LOGIN_ID || !CLIENT_KEY) {
                showMessage('error', '❌ Falta configuración de Authorize.Net en el servidor (API_LOGIN_ID o CLIENT_KEY).');
                return;
            }

            const cardNumber = document.getElementById('cardNumber').value.replace(/\\s+/g, '');
            const expMonth = document.getElementById('expMonth').value;
            const expYear = document.getElementById('expYear').value;
            const cardCode = document.getElementById('cardCode').value;
            const cardName = document.getElementById('cardName').value;
            const amount = document.getElementById('amount').value;

            if (!cardNumber || !expMonth || !expYear || !cardCode || !cardName || !amount) {
                showMessage('error', '❌ Por favor completa todos los campos.');
                return;
            }

            setLoading(true);
            showMessage('success', '⏳ Tokenizando tu tarjeta de forma segura...');

            const authData = {
                apiLoginID: API_LOGIN_ID,
                clientKey: CLIENT_KEY
            };

            const cardData = {
                cardNumber: cardNumber,
                month: expMonth,
                year: expYear,
                cardCode: cardCode
            };

            const secureData = {
                authData: authData,
                cardData: cardData
            };

            if (!window.Accept || !window.Accept.dispatchData) {
                showMessage('error', '❌ Accept.js no está cargado correctamente. Verifica la conexión.');
                setLoading(false);
                return;
            }

            Accept.dispatchData(secureData, function (response) {
                if (response.messages.resultCode === 'Error') {
                    const firstError = response.messages.message[0];
                    showMessage('error', '❌ Error tokenizando tarjeta: ' + firstError.text);
                    setLoading(false);
                    return;
                }

                const opaqueData = response.opaqueData;

                fetch(SERVER_URL + '/api/process-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: TOKEN,
                        amount: amount,
                        opaqueData: {
                            dataDescriptor: opaqueData.dataDescriptor,
                            dataValue: opaqueData.dataValue
                        }
                    })
                })
                .then(res => res.json())
                .then(result => {
                    if (result.success) {
                        showMessage('success', '✅ Pago procesado correctamente. Redirigiendo al comprobante...');
                        setTimeout(() => {
                            if (result.redirectUrl) {
                                window.location.href = result.redirectUrl;
                            } else {
                                window.location.href = SERVER_URL + '/payment-success?amount=' + encodeURIComponent(amount);
                            }
                        }, 1200);
                    } else {
                        showMessage('error', '❌ Error procesando pago: ' + (result.error || 'Error desconocido'));
                        setLoading(false);
                    }
                })
                .catch(err => {
                    showMessage('error', '❌ Error de conexión: ' + err.message);
                    setLoading(false);
                });
            });
        });
    </script>
</body>
</html>
    `;

    res.send(paymentForm);
  } catch (error) {
    console.error("❌ Error en página de pago:", error);
    res.status(500).send(`
      <div style="padding: 40px; text-align: center;">
        <h2 style="color: #af100a;">Error del servidor</h2>
        <p>No se pudo cargar la página de pago. Por favor intenta nuevamente.</p>
      </div>
    `);
  }
});

// =====================================
// PAGO DIRECTO DESDE WEB → redirige a /payment/:token
// =====================================
app.get("/pay-direct", async (req, res) => {
  console.log("💳 PAGO DIRECTO /pay-direct");

  try {
    const amountParam = req.query.amount;
    const nameParam = req.query.name;
    const referenceParam = req.query.reference;

    const amount =
      amountParam && parseFloat(amountParam) > 0 ? amountParam : "20.80";

    const customerName = nameParam || "Cliente Web";
    const customerEmail = "webpayment@ensurityexpress.com";
    const entityId = referenceParam || "WEB_PAYMENT";
    const entityType = "web";

    const token = generateSecureToken();
    const tokenData = {
      entityId,
      entityType,
      contactEmail: customerEmail,
      contactName: customerName,
      dealAmount: amount,
      timestamp: Date.now(),
      expires: Date.now() + 24 * 60 * 60 * 1000,
      flowType: "web_direct",
    };
    paymentTokens.set(token, tokenData);

    console.log("✅ Token web_direct generado, redirigiendo a /payment/:token");
    res.redirect(`/payment/${token}`);
  } catch (error) {
    console.error("💥 Error en /pay-direct:", {
      message: error.message,
      responseStatus: error.response?.status,
      responseData: error.response?.data,
    });

    res
      .status(500)
      .send("Error al iniciar el pago. Intenta nuevamente más tarde.");
  }
});

// =====================================
// API PARA ENVIAR EMAIL CON LINK DE PAGO
// =====================================
app.post("/api/send-payment-email", async (req, res) => {
  console.log("📧 SOLICITUD DE ENVÍO DE EMAIL CON LINK");

  try {
    const { entityId, entityType, clientEmail, clientName, amount } =
      req.body;

    if (!entityId || !clientEmail) {
      return res.status(400).json({
        success: false,
        error: "Datos incompletos para enviar email",
      });
    }

    let dealAmount = amount;
    if (!dealAmount) {
      try {
        const deal = await bitrix24.getDeal(entityId);
        dealAmount = deal?.OPPORTUNITY || "20.80";
      } catch (error) {
        console.error("Error obteniendo monto del deal:", error);
        dealAmount = "20.80";
      }
    }

    const token = generateSecureToken();
    const tokenData = {
      entityId,
      entityType,
      contactEmail: clientEmail,
      contactName: clientName,
      dealAmount: dealAmount,
      timestamp: Date.now(),
      expires: Date.now() + 24 * 60 * 60 * 1000,
      flowType: "email",
    };

    paymentTokens.set(token, tokenData);

    const paymentLink = `${BASE_URL}/payment/${token}`;

    await sendPaymentEmail(
      clientEmail,
      clientName,
      paymentLink,
      entityId,
      dealAmount
    );

    res.json({
      success: true,
      message: "Email enviado exitosamente con link de pago",
      clientEmail: clientEmail,
      clientName: clientName,
      entityId: entityId,
      amount: dealAmount,
      flowType: "email",
    });
  } catch (error) {
    console.error("❌ Error enviando email:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar el email",
      details: error.message,
    });
  }
});

// =====================================
// API PARA PROCESAR PAGOS CON AUTHORIZE.NET (Accept.js)
// =====================================
app.post("/api/process-payment", async (req, res) => {
  console.log("💳 PROCESANDO PAGO CON AUTHORIZE.NET (ACCEPT.JS)");

  try {
    const { token, amount, opaqueData } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token no proporcionado",
      });
    }

    const tokenData = paymentTokens.get(token);

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        error: "Token inválido o expirado",
      });
    }

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: "Monto inválido. Debe ser mayor a 0",
      });
    }

    if (!opaqueData || !opaqueData.dataDescriptor || !opaqueData.dataValue) {
      return res.status(400).json({
        success: false,
        error: "opaqueData inválido. Verifica Accept.js en el front.",
      });
    }

    console.log("🔄 Iniciando procesamiento con Authorize.Net para:", {
      client: tokenData.contactName,
      email: tokenData.contactEmail,
      amount: amount,
      entity: `${tokenData.entityType}-${tokenData.entityId}`,
    });

    const authResult = await authorizeService.createTransaction(amount, {
      opaqueData,
      customerName: tokenData.contactName,
      customerEmail: tokenData.contactEmail,
      entityId: tokenData.entityId,
      entityType: tokenData.entityType,
    });

    console.log("✅ Authorize.Net Result:", authResult);

    await sendPaymentConfirmation(tokenData.contactEmail, {
      clientName: tokenData.contactName,
      amount: amount,
      transactionId: authResult.transactionId,
      authCode: authResult.authCode,
      referenceId: authResult.referenceId,
      entityType: tokenData.entityType,
      entityId: tokenData.entityId,
      processor: "Authorize.Net",
    });

    try {
      await bitrix24.updateDeal(tokenData.entityId, {
        UF_CRM_PAYMENT_STATUS: "completed",
        UF_CRM_PAYMENT_AMOUNT: amount,
        UF_CRM_PAYMENT_DATE: new Date().toISOString(),
        UF_CRM_TRANSACTION_ID: authResult.transactionId,
        UF_CRM_AUTH_CODE: authResult.authCode,
        UF_CRM_REFERENCE_ID: authResult.referenceId,
        UF_CRM_PAYMENT_PROCESSOR: "Authorize.Net",
        UF_CRM_INVOICE_NUMBER: authResult.invoiceNumber,
      });
      console.log(`✅ Bitrix24 actualizado para deal ${tokenData.entityId}`);
    } catch (bitrixError) {
      console.error(
        "❌ Error actualizando Bitrix24:",
        bitrixError.message
      );
    }

    paymentTokens.delete(token);

    const redirectUrl = `${BASE_URL}/payment-success?amount=${encodeURIComponent(
      amount
    )}&processor=Authorize.Net&reference=${encodeURIComponent(
      authResult.referenceId || authResult.transactionId
    )}`;

    res.json({
      success: true,
      message: "Pago procesado exitosamente con Authorize.Net",
      transactionId: authResult.transactionId,
      authCode: authResult.authCode,
      referenceId: authResult.referenceId,
      amount: amount,
      clientEmail: tokenData.contactEmail,
      authResponse: authResult.fullResponse,
      redirectUrl,
    });
  } catch (error) {
    console.error(
      "❌ Error procesando pago con Authorize.Net:",
      error.message
    );

    res.status(500).json({
      success: false,
      error: "Error al procesar el pago con Authorize.Net",
      details: error.message,
    });
  }
});

// =====================================
// WEBHOOK SILENT POST DE AUTHORIZE.NET (opcional)
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
      x_email,
    } = req.body;

    if (!x_trans_id) {
      console.log("❌ Webhook sin transaction ID");
      return res.status(400).send("Missing transaction ID");
    }

    console.log("📋 Datos de transacción recibidos:", {
      transactionId: x_trans_id,
      responseCode: x_response_code,
      reason: x_response_reason_text,
      amount: x_amount,
      invoice: x_invoice_num,
      email: x_email,
    });

    if (x_response_code === "1") {
      console.log("✅ Transacción APROBADA via webhook");
    } else {
      console.log(
        "❌ Transacción DECLINADA via webhook:",
        x_response_reason_text
      );
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("💥 Error procesando webhook:", error);
    res.status(500).send("Error");
  }
});

// =====================================
// CALLBACKS DE AUTHORIZE.NET (por si usas HPP en paralelo)
// =====================================
app.get("/authorize/return", async (req, res) => {
  console.log("✅ Authorize.Net Return URL llamada (GET)");
  console.log("Query params:", req.query);

  const { transId, x_trans_id, amount, x_amount } = req.query;
  const transactionId = transId || x_trans_id;
  const transactionAmount = amount || x_amount;

  try {
    if (transactionId) {
      console.log(
        `🔍 Obteniendo detalles de transacción: ${transactionId}`
      );

      const transactionDetails =
        await authorizeService.getTransactionStatus(transactionId);
      console.log("📋 Detalles de transacción:", transactionDetails);
    }

    res.redirect(
      `${BASE_URL}/payment-success?amount=${
        transactionAmount || "0"
      }&processor=Authorize.Net&transId=${transactionId || ""}`
    );
  } catch (error) {
    console.error("❌ Error en return URL:", error);
    res.redirect(
      `${BASE_URL}/payment-success?amount=${transactionAmount || "0"}`
    );
  }
});

app.post("/authorize/return", async (req, res) => {
  console.log("✅ Authorize.Net Return URL llamada (POST)");
  console.log("Body params:", req.body);

  const { x_trans_id, x_amount } = req.body;

  try {
    if (x_trans_id) {
      console.log(`🔍 Procesando transacción vía POST: ${x_trans_id}`);
    }

    res.redirect(
      `${BASE_URL}/payment-success?amount=${
        x_amount || "0"
      }&processor=Authorize.Net&transId=${x_trans_id || ""}`
    );
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
    <title>Pago Exitoso - Ensurity Express</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: #f4f4f4;
            display: flex; justify-content: center; align-items: center; 
            height: 100vh; margin: 0; padding: 20px;
        }
        .container { 
            background: white; padding: 32px; border-radius: 15px; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.1); text-align: center; 
            max-width: 500px; width: 100%;
        }
        .success-icon { font-size: 72px; color: #af100a; margin-bottom: 20px; }
        h1 { color: #af100a; margin-bottom: 15px; font-size: 26px; }
        p { color: #6c757d; margin-bottom: 20px; line-height: 1.6; font-size: 15px; }
        .receipt { 
            background: #f8f9fa; padding: 20px; border-radius: 10px; 
            margin: 20px 0; text-align: left; border-left: 4px solid #af100a;
            font-size: 14px;
        }
        .receipt h3 { color: #af100a; margin-bottom: 12px; }
        .btn-home {
            background: linear-gradient(90deg, #af100a 0%, #5b0000 100%);
            color: white; padding: 10px 22px; border: none; border-radius: 8px;
            cursor: pointer; font-size: 14px; font-weight: 600; text-decoration: none;
            display: inline-block; margin-top: 10px;
        }
        .btn-home:hover {
            transform: translateY(-2px); box-shadow: 0 10px 20px rgba(175, 16, 10, 0.3);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✅</div>
        <h1>¡Pago exitoso!</h1>
        <p>El pago ha sido procesado correctamente a través de ${
          processor || "Authorize.Net"
        }.</p>
        <p>Si el email fue suministrado, se ha enviado un comprobante con todos los detalles.</p>

        ${
          amount
            ? `
        <div class="receipt">
            <h3>📋 Resumen del pago</h3>
            <p><strong>💰 Monto:</strong> $${amount}</p>
            ${
              reference
                ? `<p><strong>🔢 Referencia:</strong> ${reference}</p>`
                : ""
            }
            <p><strong>🏦 Procesador:</strong> ${
              processor || "Authorize.Net"
            }</p>
            <p><strong>🏪 Entorno:</strong> ${
              authorizeService.useSandbox ? "SANDBOX (Pruebas)" : "PRODUCCIÓN"
            }</p>
            <p><strong>📅 Fecha:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>⏰ Hora:</strong> ${new Date().toLocaleTimeString()}</p>
            <p><strong>🔒 Estado:</strong> Completado</p>
        </div>
        `
            : ""
        }

        <p style="font-size: 12px; color: #6c757d;">
            <strong>📧 Comprobante enviado (si se registró un email en el pago)</strong><br>
            Guarda este comprobante para tus registros.
        </p>

        <a href="${BASE_URL}" class="btn-home">
            🏠 Volver al inicio
        </a>

        <div style="margin-top: 20px; padding-top: 18px; border-top: 1px solid #e9ecef;">
            <p style="font-size: 11px; color: #6c757d;">
                <strong>Ensurity Express Payments</strong><br>
                Procesado por Authorize.Net (Accept.js)
            </p>
        </div>
    </div>

    <script>
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
    <title>Pago Fallido - Ensurity Express</title>
    <style>
        body { font-family: Arial, sans-serif; background: #f4f4f4; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
        .error-icon { font-size: 64px; color: #af100a; margin-bottom: 20px; }
        h1 { color: #af100a; margin-bottom: 15px; }
        .btn-retry { background: #af100a; color: white; padding: 10px 20px; border: none; border-radius: 5px; text-decoration: none; display: inline-block; margin-top: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">❌</div>
        <h1>Pago fallido</h1>
        <p>El pago no pudo ser procesado. Por favor intenta nuevamente.</p>
        <a href="javascript:history.back()" class="btn-retry">🔄 Reintentar pago</a>
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
    <title>Pago Cancelado - Ensurity Express</title>
    <style>
        body { font-family: Arial, sans-serif; background: #f4f4f4; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
        .warning-icon { font-size: 64px; color: #ffc107; margin-bottom: 20px; }
        h1 { color: #856404; margin-bottom: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="warning-icon">⚠️</div>
        <h1>Pago cancelado</h1>
        <p>Has cancelado el proceso de pago. Puedes intentarlo nuevamente cuando lo desees.</p>
    </div>
</body>
</html>
  `);
});

app.get("/authorize/cancel", (req, res) => {
  res.redirect("/payment-cancelled");
});

// =====================================
// HEALTH CHECK
// =====================================
app.get("/health", (req, res) => {
  const activeSessions = Array.from(paymentTokens.entries()).map(
    ([k, v]) => ({
      token: k.substring(0, 10) + "...",
      entity: `${v.entityType}-${v.entityId}`,
      email: v.contactEmail,
      flowType: v.flowType || "unknown",
      amount: v.dealAmount || "N/A",
      authorizeReference: v.authorizeReferenceId || "No asignada",
      expires: new Date(v.expires).toISOString(),
    })
  );

  res.json({
    status: "OK",
    server: "Ensurity Express Payments con Authorize.Net (Accept.js) v2.0",
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
      payDirect: "GET /pay-direct",
      authorizeReturn: "GET/POST /authorize/return",
      authorizeCancel: "GET /authorize/cancel",
      iframeCommunicator: "GET /iframe-communicator",
    },
    authorize: {
      environment: authorizeService.useSandbox ? "SANDBOX" : "PRODUCTION",
      baseUrl: authorizeService.getBaseUrl(),
      hasApiLoginId: !!authorizeService.apiLoginId,
      hasTransactionKey: !!authorizeService.transactionKey,
      hasClientKey: !!authorizeService.clientKey,
      apiLoginId: authorizeService.apiLoginId
        ? `${authorizeService.apiLoginId.substring(0, 4)}...`
        : "No configurado",
    },
    sessions: {
      active: paymentTokens.size,
      details: activeSessions,
    },
    stats: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    },
  });
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
      <body style="font-family: Arial, sans-serif; padding: 20px; background: #f4f4f4;">
        <div style="max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1>🧪 Testing Widget Bitrix24</h1>
          <p>Testing <strong>${testEntityType}</strong> ID: <strong>${testEntityId}</strong></p>
          <button onclick="testPost()" style="background: #af100a; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">
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
    message: "Ensurity Express Payments API con Authorize.Net (Accept.js)",
    version: "2.0",
    status: "running",
    baseUrl: BASE_URL,
    endpoints: {
      health: "/health",
      widget: "/widget/bitrix24",
      payment: "/payment/{token}",
      payDirect: "/pay-direct",
      documentation: "Ver /health para todos los endpoints",
    },
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
    details: err.message,
  });
});

// =====================================
// Inicializar servidor
// =====================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `🚀 Servidor Ensurity Express Payments (Accept.js) ejecutándose en puerto ${PORT}`
  );
  console.log(`🔗 URL Base: ${BASE_URL}`);
  console.log(`🎯 Widget: POST ${BASE_URL}/widget/bitrix24`);
  console.log(`🔗 Webhook: POST ${BASE_URL}/webhook/bitrix24`);
  console.log(`💳 Pagos: GET ${BASE_URL}/payment/{token}`);
  console.log(`💳 Pago directo: GET ${BASE_URL}/pay-direct`);
  console.log(`✅ Éxito: GET ${BASE_URL}/payment-success`);
  console.log(`📧 Email: POST ${BASE_URL}/api/send-payment-email`);
  console.log(`💳 Procesar: POST ${BASE_URL}/api/process-payment`);
  console.log(`↩️  Authorize Return: GET/POST ${BASE_URL}/authorize/return`);
  console.log(`❌ Authorize Cancel: GET ${BASE_URL}/authorize/cancel`);
  console.log(`🖼️  Iframe Communicator: GET ${BASE_URL}/iframe-communicator`);
  console.log(`❤️  Health: GET ${BASE_URL}/health`);
  console.log(
    `🏦 Authorize.Net: ${
      authorizeService.useSandbox ? "SANDBOX" : "PRODUCTION"
    } - ${authorizeService.getBaseUrl()}`
  );
});
