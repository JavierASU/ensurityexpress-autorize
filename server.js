// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const morgan = require("morgan");
const nodemailer = require("nodemailer");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config();

const app = express();

// =========================
// CONFIGURACIÓN DE URL DESDE .ENV
// =========================
const BASE_URL =
  process.env.BASE_URL || "https://kqgavtfrpt.us-east-1.awsapprunner.com";
const WEBSITE_URL = "https://ensurityexpress.com";

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
app.use("/imagenes", express.static(path.join(__dirname, "imagenes")));

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

// Verify SMTP connection
transporter.verify(function (error) {
  if (error) {
    console.log("❌ SMTP configuration error:", error);
  } else {
    console.log("✅ SMTP server ready to send emails");
  }
});

// In-memory storage
const paymentTokens = new Map();
const clientDataStore = new Map();

// =====================================
// BITRIX24 CLASS
// =====================================
class Bitrix24 {
  constructor() {
    this.webhookUrl =
      process.env.BITRIX24_WEBHOOK_URL ||
      "https://ensurityexpress.bitrix24.com/rest/65/v6hyou7s4l7fpj5l";
    this.productWebhookUrl = 
      "https://ensurityexpress.bitrix24.com/rest/65/jyxsjzrx0nynhkou";
  }

  async getDeal(dealId) {
    try {
      console.log(`🔍 Getting deal ${dealId}...`);
      const response = await axios.get(`${this.webhookUrl}/crm.deal.get`, {
        params: { id: dealId },
      });

      if (response.data.result) {
        console.log(`✅ Deal obtained:`, {
          title: response.data.result.TITLE,
          contactId: response.data.result.CONTACT_ID,
          stageId: response.data.result.STAGE_ID,
          amount: response.data.result.OPPORTUNITY,
        });
        return response.data.result;
      } else {
        console.log("❌ Deal not found");
        return null;
      }
    } catch (error) {
      console.error("❌ Error getting deal:", error.message);
      throw error;
    }
  }

  async getContactFromDeal(dealId) {
    try {
      console.log(`🔍 Getting contact from deal ${dealId}...`);
      const deal = await this.getDeal(dealId);

      if (deal && deal.CONTACT_ID && deal.CONTACT_ID !== "0") {
        console.log(`✅ Deal has associated contact: ${deal.CONTACT_ID}`);
        const contact = await this.getContact(deal.CONTACT_ID);
        return contact;
      } else {
        console.log("❌ Deal has no valid associated contact");
        return null;
      }
    } catch (error) {
      console.error("❌ Error getting contact from deal:", error.message);
      return null;
    }
  }

  async getContact(contactId) {
    try {
      console.log(`🔍 Getting contact ${contactId}...`);
      const response = await axios.get(`${this.webhookUrl}/crm.contact.get`, {
        params: { id: contactId },
      });

      if (response.data.result) {
        console.log(`✅ Contact obtained:`, {
          name: `${response.data.result.NAME || ""} ${
            response.data.result.LAST_NAME || ""
          }`,
          email: response.data.result.EMAIL?.[0]?.VALUE || "Not available",
          phone: response.data.result.PHONE?.[0]?.VALUE || "Not available",
        });
      }

      return response.data.result;
    } catch (error) {
      console.error("❌ Error getting contact:", error.message);
      throw error;
    }
  }

  // 🔹 NUEVO MÉTODO: Obtener productos del deal
  async getDealProducts(dealId) {
    try {
      console.log(`🛒 Getting products for deal ${dealId}...`);
      
      const response = await axios.get(`${this.productWebhookUrl}/crm.deal.productrows.get`, {
        params: { 
          id: dealId
        }
      });

      if (response.data && response.data.result) {
        const products = response.data.result;
        console.log(`✅ Found ${products.length} products for deal ${dealId}:`, 
          products.map(p => ({
            id: p.PRODUCT_ID,
            name: p.PRODUCT_NAME || 'Sin nombre',
            price: p.PRICE,
            quantity: p.QUANTITY,
            total: p.PRICE * p.QUANTITY
          }))
        );
        
        return products;
      } else {
        console.log(`📭 No products found for deal ${dealId}`);
        return [];
      }
    } catch (error) {
      console.error("❌ Error getting deal products:", error.message);
      return [];
    }
  }

  // 🔹 MÉTODO MEJORADO: Obtener deal con productos
  async getDealWithProducts(dealId) {
    try {
      console.log(`🔍 Getting deal ${dealId} with products...`);
      const [deal, products] = await Promise.all([
        this.getDeal(dealId),
        this.getDealProducts(dealId)
      ]);

      if (deal) {
        deal.PRODUCTS = products;
        deal.PRODUCTS_SUMMARY = this.formatProductsSummary(products);
      }

      return deal;
    } catch (error) {
      console.error("❌ Error getting deal with products:", error.message);
      return null;
    }
  }

  // 🔹 Formatear resumen de productos para mostrar/email
  formatProductsSummary(products) {
    if (!products || products.length === 0) {
      return "Services";
    }

    // Si hay solo un producto, devolver su nombre
    if (products.length === 1) {
      const product = products[0];
      return product.PRODUCT_NAME || "Product";
    }

    // Si hay múltiples productos, crear un resumen
    const productNames = products
      .map(p => p.PRODUCT_NAME)
      .filter(name => name && name.trim() !== "");
    
    if (productNames.length === 0) return "Multiple products";
    
    if (productNames.length === 1) return productNames[0];
    
    if (productNames.length <= 3) {
      return productNames.join(", ");
    }
    
    return `${productNames[0]} and ${productNames.length - 1} more products`;
  }

  async updateDeal(dealId, data) {
    try {
      console.log(`🔄 Updating deal ${dealId}...`);
      const response = await axios.post(`${this.webhookUrl}/crm.deal.update`, {
        id: dealId,
        fields: data,
      });
      console.log(`✅ Deal updated successfully`);
      return response.data.result;
    } catch (error) {
      console.error("❌ Error updating deal:", error.message);
      throw error;
    }
  }
}

// =====================================
// AUTHORIZE.NET SERVICE CLASS
// =====================================
class AuthorizeNetService {
  constructor() {
    this.sandboxUrl = "https://apitest.authorize.net";
    this.productionUrl = "https://api.authorize.net";

    this.apiLoginId = process.env.AUTHORIZE_API_LOGIN_ID;
    this.transactionKey = process.env.AUTHORIZE_TRANSACTION_KEY;
    this.useSandbox = (process.env.AUTHORIZE_USE_SANDBOX || "false") === "true";

    // Límite típico de Authorize.Net para invoiceNumber
    this.INVOICE_MAX_LEN = 20;

    console.log("🚨 VERIFICACIÓN AUTHORIZE.NET CONFIGURACIÓN:", {
      environment: this.useSandbox ? "SANDBOX" : "PRODUCCIÓN",
      apiLoginId: this.apiLoginId ? "PRESENTE" : "FALTANTE",
      transactionKey: this.transactionKey ? "PRESENTE" : "FALTANTE",
      baseUrl: this.getBaseUrl(),
      tokenBaseUrl: this.useSandbox
        ? "https://test.authorize.net"
        : "https://accept.authorize.net",
      baseAppUrl: BASE_URL,
    });
  }

  getBaseUrl() {
    return this.useSandbox ? this.sandboxUrl : this.productionUrl;
  }

  // 🔹 SIEMPRE usar formato EX000XL00TX
  buildInvoiceNumber(entityId = "WEB") {
    const numId = parseInt(entityId) || 0;
    const paddedId = numId.toString().padStart(3, '0');
    
    // Contador basado en timestamp (últimos 2 dígitos del segundo actual)
    const timestamp = Date.now();
    const counter = (Math.floor(timestamp / 1000) % 100).toString().padStart(2, '0');
    
    return `EX${paddedId}XL${counter}TX`;
  }

  generateReferenceId() {
    return `AUTH${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
  }

  // Crear transacción de pago
  async createTransaction(amount, paymentData) {
    try {
      console.log("🔄 Creando transacción en Authorize.Net...");

      // 🔹 Determinar descripción según productos
      let description;
      if (paymentData.products && paymentData.products.length > 0) {
        const productNames = paymentData.products
          .map(p => p.PRODUCT_NAME)
          .filter(name => name)
          .slice(0, 2);
        description = productNames.length > 0 
          ? `Payment for: ${productNames.join(', ')}${paymentData.products.length > 2 ? '...' : ''}`
          : `Payment for ${paymentData.customerName}`;
      } else if (paymentData.isEmailFlow) {
        description = `Payment for ${paymentData.customerName}`;
      } else {
        description = `Payment for ${paymentData.entityType} ${paymentData.entityId}`;
      }

      // Limitar longitud de descripción
      const MAX_DESC_LENGTH = 255;
      if (description.length > MAX_DESC_LENGTH) {
        description = description.substring(0, MAX_DESC_LENGTH - 3) + '...';
      }

      const payload = {
        createTransactionRequest: {
          merchantAuthentication: {
            name: this.apiLoginId,
            transactionKey: this.transactionKey,
          },
          transactionRequest: {
            transactionType: "authCaptureTransaction",
            amount: amount.toString(),
            payment: {
              creditCard: {
                cardNumber: paymentData.cardNumber,
                expirationDate: paymentData.expiry,
                cardCode: paymentData.cvv,
              },
            },
            order: {
              // 🔹 SIEMPRE nuevo formato EX000XL00TX
              invoiceNumber: this.buildInvoiceNumber(paymentData.entityId),
              description: description,
            },
            customer: {
              email: paymentData.customerEmail,
            },
            billTo: {
              firstName: paymentData.customerName.split(" ")[0],
              lastName:
                paymentData.customerName.split(" ").slice(1).join(" ") ||
                "Customer",
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
          },
        },
      };

      console.log("📤 Sending request to Authorize.Net:", {
        url: `${this.getBaseUrl()}/xml/v1/request.api`,
        invoiceNumber: payload.createTransactionRequest.transactionRequest.order.invoiceNumber,
        description: description,
      });

      const response = await axios.post(
        `${this.getBaseUrl()}/xml/v1/request.api`,
        payload,
        {
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
        }
      );

      console.log("✅ Authorize.Net Response:", response.data);

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
          "Transaction failed in Authorize.Net";
        throw new Error(errorMsg);
      }
    } catch (error) {
      console.error("❌ Error processing transaction with Authorize.Net:", {
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

  // Create Hosted Payment Page (HPP) for Accept Hosted
  async createHostedPaymentPage(paymentData) {
    try {
      console.log("🔄 Creating hosted payment page...");
      console.log("📝 Payment data:", {
        client: paymentData.customerName,
        email: paymentData.customerEmail,
        amount: paymentData.amount,
        entity: `${paymentData.entityType}-${paymentData.entityId}`,
        description: paymentData.description || null,
        isEmailFlow: paymentData.isEmailFlow || false,
        productsCount: paymentData.products?.length || 0,
      });

      // 🔹 Determinar descripción según productos
      let description;
      if (paymentData.products && paymentData.products.length > 0) {
        const productNames = paymentData.products
          .map(p => p.PRODUCT_NAME)
          .filter(name => name)
          .slice(0, 2);
        description = productNames.length > 0 
          ? `Payment for: ${productNames.join(', ')}${paymentData.products.length > 2 ? '...' : ''}`
          : `Payment for ${paymentData.customerName}`;
      } else if (paymentData.isEmailFlow) {
        description = `Payment for ${paymentData.customerName}`;
      } else if (paymentData.description && paymentData.description.trim().length > 0) {
        description = paymentData.description.trim();
      } else {
        description = `Payment for ${paymentData.entityType} ${paymentData.entityId}`;
      }

      // Limitar longitud de descripción
      const MAX_DESC_LENGTH = 255;
      if (description.length > MAX_DESC_LENGTH) {
        description = description.substring(0, MAX_DESC_LENGTH - 3) + '...';
      }

      const tokenPayload = {
        getHostedPaymentPageRequest: {
          merchantAuthentication: {
            name: this.apiLoginId,
            transactionKey: this.transactionKey,
          },
          transactionRequest: {
            transactionType: "authCaptureTransaction",
            amount: paymentData.amount.toString(),
            order: {
              // 🔹 SIEMPRE nuevo formato EX000XL00TX
              invoiceNumber: this.buildInvoiceNumber(paymentData.entityId),
              description: description,
            },
            customer: {
              email: paymentData.customerEmail,
            },
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
                  cancelUrlText: "Cancel",
                }),
              },
              {
                settingName: "hostedPaymentIFrameCommunicatorUrl",
                settingValue: JSON.stringify({
                  url: `${BASE_URL}/iframe-communicator`,
                }),
              },
            ],
          },
        },
      };

      console.log("📤 Sending HPP request to Authorize.Net:", {
        url: `${this.getBaseUrl()}/xml/v1/request.api`,
        environment: this.useSandbox ? "SANDBOX" : "PRODUCTION",
        invoiceNumber: tokenPayload.getHostedPaymentPageRequest.transactionRequest.order.invoiceNumber,
        description: description,
      });

      const response = await axios.post(
        `${this.getBaseUrl()}/xml/v1/request.api`,
        tokenPayload,
        {
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
        }
      );

      console.log(
        "✅ HPP Response from Authorize.Net:",
        JSON.stringify(response.data, null, 2)
      );

      const result = response.data;

      if (result.token) {
        const postUrl = `${
          this.useSandbox
            ? "https://test.authorize.net"
            : "https://accept.authorize.net"
        }/payment/payment`;

        console.log("🔗 Payment URL (POST):", postUrl);
        console.log(
          "🔍 Token for POST:",
          result.token.substring(0, 50) + "..."
        );

        return {
          success: true,
          postUrl: postUrl,
          token: result.token,
          referenceId: this.generateReferenceId(),
          message: "Hosted payment page generated successfully",
        };
      } else {
        const errorMsg =
          result.messages?.message?.[0]?.text ||
          "Error generating payment page";
        console.error("❌ Error in HPP response:", errorMsg);
        throw new Error(errorMsg);
      }
    } catch (error) {
      console.error("💥 Error creating HPP:", {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        url: error.config?.url,
      });
      throw error;
    }
  }

  // Verify transaction status
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
        "❌ Error verifying transaction:",
        error.response?.data || error.message
      );
      throw error;
    }
  }
}

// Initialize services
const authorizeService = new AuthorizeNetService();
const bitrix24 = new Bitrix24();

// Generate secure token
function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ================================
// EMAIL FUNCTIONS
// ================================
async function sendPaymentEmail(
  email,
  clientName,
  paymentLink,
  dealId,
  amount = null,
  products = null
) {
  try {
    // Get the deal amount if not provided
    let dealAmount = amount;
    let productsSummary = "Services";
    let productsList = [];
    
    if (dealId) {
      try {
        // 🔹 OBTENER PRODUCTOS SI NO VIENEN EN PARÁMETRO
        if (!products) {
          const dealProducts = await bitrix24.getDealProducts(dealId);
          products = dealProducts;
        }
        
        // 🔹 OBTENER INFO DEL DEAL SI NO HAY MONTO
        if (!dealAmount) {
          const deal = await bitrix24.getDeal(dealId);
          dealAmount = deal?.OPPORTUNITY || "20.80";
        }
        
        // 🔹 FORMATEAR RESUMEN DE PRODUCTOS
        if (products && products.length > 0) {
          productsSummary = bitrix24.formatProductsSummary(products);
          productsList = products.map(p => ({
            name: p.PRODUCT_NAME || 'Product',
            quantity: p.QUANTITY || 1,
            price: p.PRICE || 0,
            total: (p.PRICE || 0) * (p.QUANTITY || 1)
          }));
        }
      } catch (error) {
        console.error("Error getting deal info:", error);
        dealAmount = "20.80";
      }
    } else if (!dealAmount) {
      dealAmount = "20.80";
    }

    // 🔹 Generar invoice number
    const invoiceNumber = authorizeService.buildInvoiceNumber(dealId);

    // 🔹 CONSTRUIR HTML CON PRODUCTOS
    let productsHtml = '';
    if (productsList.length > 0) {
      productsHtml = `
        <div style="margin: 15px 0; padding: 15px; background: #f8f9fa; border-radius: 8px;">
          <h3 style="color: #af100a; margin-bottom: 10px; font-size: 16px;">📦 Products/Services:</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <thead>
              <tr style="background: #e9ecef;">
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #dee2e6;">Description</th>
                <th style="padding: 8px; text-align: right; border-bottom: 2px solid #dee2e6;">Qty</th>
                <th style="padding: 8px; text-align: right; border-bottom: 2px solid #dee2e6;">Price</th>
                <th style="padding: 8px; text-align: right; border-bottom: 2px solid #dee2e6;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${productsList.map(product => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${product.name}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #dee2e6;">${product.quantity}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #dee2e6;">$${product.price.toFixed(2)}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #dee2e6;">$${product.total.toFixed(2)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    const mailOptions = {
      from: `"Ensurity Express Payments" <${process.env.SMTP_USER || "invoice@ensurityexpress.com"}>`,
      to: email,
      subject: `Payment Invoice from Ensurity Express - ${productsSummary}`,
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
        table { width: 100%; border-collapse: collapse; }
        th { background: #f8f9fa; font-weight: 600; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Ensurity Express Tax Solutions</h1>
        <p>Secure Payment System</p>
    </div>

    <div class="content">
        <p>Hello <strong>${clientName}</strong>,</p>
        <p>You have received a payment invoice for:</p>
        
        <div class="amount-info">
            <h3 style="margin-top: 0; color: #af100a;">Invoice #${invoiceNumber}</h3>
            <p><strong>Customer:</strong> ${clientName}</p>
            <p><strong>Description:</strong> ${productsSummary}</p>
            <p><strong>Total Amount:</strong> <strong style="font-size: 18px;">$${dealAmount} USD</strong></p>
        </div>

        ${productsHtml}

        <p>To complete your payment, click the button below:</p>

        <div style="text-align: center; margin: 24px 0;">
            <a href="${paymentLink}" class="payment-link" target="_blank">
                💳 PAY INVOICE NOW
            </a>
        </div>

        <p><strong>Important:</strong></p>
        <ul>
            <li>This link is valid for 24 hours.</li>
            <li>The amount of <strong>$${dealAmount} USD</strong> is fixed for this transaction.</li>
            <li>Payment is processed through our secure payment system.</li>
        </ul>

        <p>If you have any questions, please contact us.</p>
        <p style="text-align: center;">
          Ensurity Express Tax Solutions<br>
          935 W RALPH HALL PKY 101<br>
          ROCKWALL TX, 75032<br>
          469-4847873<br>
        </p>
    </div>

    <div class="footer">
        <p>Ensurity Express Payments System<br>
        <small>This is an automated email, please do not reply to this message.</small></p>
    </div>
</body>
</html>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to: ${email} for: ${productsSummary}`);
    return info;
  } catch (error) {
    console.error("❌ Error sending email:", error);
    throw error;
  }
}

async function sendPaymentConfirmation(email, paymentData) {
  try {
    const mailOptions = {
      from: `"Ensurity Express Payments" <${process.env.SMTP_USER || "invoice@ensurityexpress.com"}>`,
      to: email,
      subject: `✅ Payment Confirmation - ${paymentData.transactionId}`,
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
        <h1>✅ Payment Confirmed</h1>
        <p>Ensurity Express Tax Solutions</p>
    </div>

    <div class="content">
        <h2>Hello ${paymentData.clientName},</h2>
        <p>Your payment has been successfully processed.</p>

        <div class="receipt">
            <h3>📋 Payment Receipt</h3>
            <p><strong>Invoice Number:</strong> ${paymentData.invoiceNumber || 'N/A'}</p>
            <p><strong>Customer:</strong> ${paymentData.clientName}</p>
            <p><strong>Amount:</strong> $${paymentData.amount}</p>
            <p><strong>Transaction ID:</strong> ${paymentData.transactionId}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Time:</strong> ${new Date().toLocaleTimeString()}</p>
        </div>

        <p>We have recorded your payment in our system. This receipt serves as an official proof of payment.</p>

        <p><strong>Thank you for trusting Ensurity Express.</strong></p>
    </div>

    <div class="footer">
        <p>Ensurity Express Tax Solutions<br>
        <small>This is an automated email, please do not reply to this message.</small></p>
    </div>
</body>
</html>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Confirmation email sent to: ${email}`);
    return info;
  } catch (error) {
    console.error("❌ Error sending confirmation email:", error);
    throw error;
  }
}

// =====================================
// IFRAME COMMUNICATOR FOR AUTHORIZE.NET
// =====================================
app.get("/iframe-communicator", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Ensurity Express - Payment Communicator</title>
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
        
        // Notify that the iframe is ready
        if (window.parent !== window) {
            window.parent.postMessage("iframeReady", "*");
        }
    </script>
</head>
<body>
    <p>Ensurity Express Payment Communicator</p>
</body>
</html>
  `);
});

// =====================================
// MAIN BITRIX24 WIDGET ROUTE
// =====================================
app.post("/widget/bitrix24", async (req, res) => {
  console.log("🎯 BITRIX24 WIDGET CALLED (POST)");
  console.log("PLACEMENT:", req.body.PLACEMENT);
  console.log("PLACEMENT_OPTIONS:", req.body.PLACEMENT_OPTIONS);

  try {
    const { PLACEMENT_OPTIONS, PLACEMENT } = req.body;

    let contactData = null;
    let entityId = null;
    let entityType = null;
    let hasValidContact = true;
    let dealAmount = null;
    let dealProducts = [];

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
        console.log(`👤 It is a CONTACT: ${entityId}`);
        contactData = await bitrix24.getContact(entityId);
      } else if (PLACEMENT === "CRM_DEAL_DETAIL_TAB") {
        entityType = "deal";
        console.log(`💼 It is a DEAL: ${entityId}`);
        contactData = await bitrix24.getContactFromDeal(entityId);

        const deal = await bitrix24.getDealWithProducts(entityId);
        dealAmount = deal?.OPPORTUNITY || "20.80";
        dealProducts = deal?.PRODUCTS || [];
        console.log(`💰 Deal amount: $${dealAmount}`);
        console.log(`🛒 Products found: ${dealProducts.length}`);

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
                    <p>Secure payment system</p>
                </div>
                <div class="content">
                    <div class="warning">
                        <h3>⚠️ Required information</h3>
                        <p>This ${entityType} does not have a valid associated contact.</p>
                        <p>Please assign a contact to the ${entityType} to generate payment links.</p>
                    </div>
                    <button class="btn" onclick="testConnection()">
                        🔗 Test connection
                    </button>
                    <div id="result"></div>
                </div>
            </div>
            <script>
                async function testConnection() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = '⏳ Testing connection...';
                    try {
                        const response = await fetch('${BASE_URL}/health');
                        const result = await response.json();
                        resultDiv.innerHTML = '✅ Successful connection to server';
                    } catch (error) {
                        resultDiv.innerHTML = '❌ Connection error';
                    }
                }
            </script>
        </body>
        </html>
      `;
    } else {
      const clientEmail = contactData?.EMAIL?.[0]?.VALUE || "No disponible";
      const clientName = contactData
        ? `${contactData.NAME || ""} ${contactData.LAST_NAME || ""}`.trim()
        : "Cliente no disponible";
      const clientPhone = contactData?.PHONE?.[0]?.VALUE || "No disponible";

      // 🔹 CONSTRUIR HTML CON PRODUCTOS
      let productsHtml = '';
      if (dealProducts.length > 0) {
        productsHtml = `
          <div style="margin: 12px 0; padding: 12px; background: #f0f9ff; border-radius: 6px; border-left: 4px solid #007bff;">
            <h4 style="margin: 0 0 8px 0; color: #0056b3; font-size: 13px; display: flex; align-items: center; gap: 6px;">
              📦 Products/Services in this deal:
            </h4>
            <ul style="margin: 0; padding-left: 18px; font-size: 12px;">
              ${dealProducts.slice(0, 3).map(product => `
                <li style="margin-bottom: 4px;">
                  <strong>${product.PRODUCT_NAME || 'Product'}</strong> 
                  - Qty: ${product.QUANTITY || 1} 
                  - $${product.PRICE || 0} each
                </li>
              `).join('')}
              ${dealProducts.length > 3 ? `<li>... and ${dealProducts.length - 3} more</li>` : ''}
            </ul>
          </div>
        `;
      }

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
            <p>Secure payment system</p>
        </div>

        <div class="content">
            <div class="client-info">
                <h3>👤 Client information</h3>
                <div class="info-item">
                    <span class="info-icon">👤</span>
                    <span><strong>Name:</strong> ${clientName}</span>
                </div>
                <div class="info-item">
                    <span class="info-icon">📧</span>
                    <span><strong>Email:</strong> ${clientEmail}</span>
                </div>
                <div class="info-item">
                    <span class="info-icon">📞</span>
                    <span><strong>Phone:</strong> ${clientPhone}</span>
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
                        <span><strong>Deal amount:</strong> $${dealAmount} USD</span>
                    </div>
                </div>
                `
                    : ""
                }
                ${productsHtml}
            </div>

            <button class="btn" onclick="generatePaymentLink()">
                🎯 Generate payment link
            </button>

            <button class="btn btn-success" onclick="sendPaymentEmailToClient()">
                📧 Send link by email
            </button>

            <button class="btn btn-secondary" onclick="testConnection()">
                🔗 Test connection
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
        const DEAL_PRODUCTS = ${JSON.stringify(dealProducts)};

        async function generatePaymentLink() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<div style="text-align: center;"><div class="loading"></div><br>⏳ Generating secure payment link...</div>';
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
                            DEAL_AMOUNT: DEAL_AMOUNT,
                            PRODUCTS: DEAL_PRODUCTS
                        })
                    })
                });

                const result = await response.json();

                if (result.success) {
                    const paymentLink = result.paymentLink;
                    resultDiv.innerHTML =
                        '<div style="color: #af100a; text-align: center;">' +
                        '✅ <strong>Link generated successfully</strong></div><br>' +
                        '<strong>🔗 Secure payment link:</strong><br>' +
                        '<div class="link-display">' + paymentLink + '</div><br>' +
                        '<div class="amount-info">' +
                        '<strong>💡 Note:</strong> The client can modify the amount on the payment portal.' +
                        '</div><br>' +
                        '<button class="btn" onclick="copyToClipboard(\\'' + paymentLink + '\\')">📋 Copy link</button>' +
                        '<div style="margin-top: 10px; padding: 8px; background: #ffeaea; border-radius: 5px; font-size: 11px; color: #af100a;">' +
                        '💡 Send this link to the client to complete the payment.' +
                        '</div>';
                    resultDiv.className = 'result success';
                } else {
                    resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Error:</strong> ' + (result.error || 'Error generating link') + '</div>';
                    resultDiv.className = 'result error';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Connection error:</strong> ' + error.message + '</div>';
                resultDiv.className = 'result error';
            }
        }

        async function sendPaymentEmailToClient() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<div style="text-align: center;"><div class="loading"></div><br>📧 Sending email to client...</div>';
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
                        amount: DEAL_AMOUNT,
                        products: DEAL_PRODUCTS
                    })
                });

                const result = await response.json();

                if (result.success) {
                    resultDiv.innerHTML =
                        '<div style="color: #af100a; text-align: center;">' +
                        '✅ <strong>Email sent successfully</strong></div><br>' +
                        '<div class="email-section">' +
                        '<strong>📧 Recipient:</strong> ' + CLIENT_EMAIL + '<br>' +
                        '<strong>👤 Client:</strong> ' + CLIENT_NAME + '<br>' +
                        '<strong>💰 Amount:</strong> $' + DEAL_AMOUNT + ' USD<br>' +
                        '<strong>📦 Products:</strong> ' + (DEAL_PRODUCTS.length > 0 ? DEAL_PRODUCTS.length + ' products' : 'Not specified') + '<br>' +
                        '<strong>🆔 Reference:</strong> ' + ENTITY_TYPE + '-' + ENTITY_ID +
                        '</div>' +
                        '<div style="margin-top: 10px; padding: 8px; background: #d4edda; border-radius: 5px; font-size: 11px; color: #155724;">' +
                        '💡 The client received the payment link by email with product details.' +
                        '</div>';
                    resultDiv.className = 'result success';
                } else {
                    resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Error:</strong> ' + (result.error || 'Error sending email') + '</div>';
                    resultDiv.className = 'result error';
                }
            } catch (error) {
                resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Connection error:</strong> ' + error.message + '</div>';
                resultDiv.className = 'result error';
            }
        }

        async function testConnection() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<div style="text-align: center;"><div class="loading"></div><br>⏳ Testing connection...</div>';
            resultDiv.className = 'result';

            try {
                const response = await fetch(SERVER_URL + '/health');
                const result = await response.json();
                resultDiv.innerHTML =
                    '<div style="color: #af100a; text-align: center;">' +
                    '✅ <strong>Successful connection</strong></div><br>' +
                    '<div style="text-align: left; font-size: 11px;">' +
                    '<div><strong>Server:</strong> ' + result.server + '</div>' +
                    '<div><strong>URL:</strong> ' + SERVER_URL + '</div>' +
                    '</div>';
                resultDiv.className = 'result success';
            } catch (error) {
                resultDiv.innerHTML = '<div style="color: #dc3545;">❌ <strong>Connection error</strong><br>' + error.message + '</div>';
                resultDiv.className = 'result error';
            }
        }

        function copyToClipboard(text) {
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => {
                    alert('✅ Link copied to clipboard!');
                }).catch(err => {
                    fallbackCopyToClipboard(text);
                });
            } else {
                fallbackCopyToClipboard(text);
            }
        }

        function fallbackCopyToClipboard(text) {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-999999px";
            textArea.style.top = "-999999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            try {
                document.execCommand('copy');
                alert('✅ Link copied to clipboard!');
            } catch (err) {
                console.error('Fallback: Oops, unable to copy', err);
                alert('❌ Failed to copy link. Please copy manually.');
            }
            
            document.body.removeChild(textArea);
        }

        window.addEventListener('load', function () {
            setTimeout(testConnection, 1000);
        });
    </script>
</body>
</html>
      `;
    }

    console.log("✅ Sending widget HTML to Bitrix24");
    res.send(widgetHTML);
  } catch (error) {
    console.error("💥 Error in widget:", error);
    res.status(500).send(`
      <div style="padding: 20px; background: #f8d7da; color: #721c24; border-radius: 8px; text-align: center;">
        <h3>❌ Widget Error</h3>
        <p><strong>Details:</strong> ${error.message}</p>
        <button style="padding: 10px 20px; background: #af100a; color: white; border: none; border-radius: 5px; cursor: pointer;" 
                onclick="location.reload()">🔄 Retry</button>
      </div>
    `);
  }
});

// =====================================
// WEBHOOK TO GENERATE PAYMENT LINKS
// =====================================
app.post("/webhook/bitrix24", async (req, res) => {
  console.log("🔗 BITRIX24 WEBHOOK CALLED");
  console.log("Body:", req.body);

  try {
    const { PLACEMENT_OPTIONS } = req.body;

    if (!PLACEMENT_OPTIONS) {
      return res.status(400).json({
        success: false,
        error: "PLACEMENT_OPTIONS not found",
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
        error: "PLACEMENT_OPTIONS is not valid JSON",
      });
    }

    const entityId = options.ENTITY_ID;
    const entityType = options.ENTITY_TYPE;
    const contactEmail = options.CONTACT_EMAIL;
    const contactName = options.CONTACT_NAME;
    const dealAmount = options.DEAL_AMOUNT;
    const products = options.PRODUCTS || [];

    if (!entityId) {
      return res.status(400).json({
        success: false,
        error: "Entity ID not found",
      });
    }

    const token = generateSecureToken();
    const tokenData = {
      entityId,
      entityType,
      contactEmail,
      contactName,
      dealAmount: dealAmount || null,
      products: products,
      timestamp: Date.now(),
      expires: Date.now() + 24 * 60 * 60 * 1000,
      flowType: "direct_link",
      isEmailFlow: false,
    };

    paymentTokens.set(token, tokenData);
    console.log(
      `✅ Token generated for ${entityType} ${entityId} - Products: ${products.length}`
    );

    const paymentLink = `${BASE_URL}/payment/${token}`;

    res.json({
      success: true,
      paymentLink: paymentLink,
      entityId: entityId,
      entityType: entityType,
      contactEmail: contactEmail,
      productsCount: products.length,
      flowType: "direct_link",
      message:
        "Payment link generated successfully - Client can modify amount",
    });
  } catch (error) {
    console.error("❌ Error in webhook:", error);
    res.status(500).json({
      success: false,
      error: "Error processing the request",
    });
  }
});

// =====================================
// PAYMENT ROUTE WITH TOKEN (BANNER + HPP IN IFRAME)
// =====================================
app.get("/payment/:token", async (req, res) => {
  const { token } = req.params;

  console.log(`🔐 Accessing payment with token: ${token.substring(0, 10)}...`);

  try {
    const tokenData = paymentTokens.get(token);

    if (!tokenData) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Invalid Link - Ensurity Express</title>
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
                <h1>Invalid or expired link</h1>
                <p>This payment link has expired or is invalid.</p>
                <p>Please request a new payment link from the agent.</p>
            </div>
        </body>
        </html>
      `);
    }

    if (Date.now() > tokenData.expires) {
      paymentTokens.delete(token);
      console.log("⏰ Token expired");
      return res.status(410).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Expired Link - Ensurity Express</title>
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
                <h1>Expired link</h1>
                <p>This payment link has expired.</p>
                <p>Please request a new link from the agent.</p>
            </div>
        </body>
        </html>
      `);
    }

    console.log(
      `✅ Token valid for: ${tokenData.contactName} (${tokenData.contactEmail}) - Products: ${tokenData.products?.length || 0}`
    );

    // Amount to be used in the HPP (email, widget, web, etc.)
    const defaultAmount = tokenData.dealAmount || "20.80";

    // 🌐 Page that displays ONLY your banner + iframe with the HPP
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Ensurity Express - Secure Payment</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      background: #ffffff;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    /* 🟥 Top banner like Invoice (we don't touch the HPP) */
    .top-banner {
      background-color: #5b0000;
      color: #ffffff;
      padding: 20px 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .banner-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .banner-logo {
      height: 48px;
    }
    .banner-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .banner-title-main {
      font-size: 22px;
      font-weight: 600;
    }
    .banner-title-sub {
      font-size: 12px;
    }
    .banner-right {
      text-align: right;
      font-size: 12px;
      line-height: 1.4;
    }
    /* iframe container */
    .iframe-wrapper {
      flex: 1;
      background: #f4f4f4;
      padding: 20px 0;
    }
    .iframe-inner {
      width: 100%;
      max-width: 960px;
      margin: 0 auto;
      height: 100%;
      background: #ffffff;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    .loading-box {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #555;
      font-size: 14px;
    }
    .loader {
      border: 4px solid #f3f3f3;
      border-top: 4px solid #5b0000;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      animation: spin 1s linear infinite;
      margin-bottom: 10px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .error-box {
      padding: 20px;
      color: #721c24;
      background: #f8d7da;
      text-align: center;
      font-size: 14px;
    }
    .error-box button {
      margin-top: 10px;
      background: #5b0000;
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <!-- 🟥 Top banner: here you control logo/texts so it looks the same as the image -->
  <div class="top-banner">
    <div class="banner-left">
      <img
        class="banner-logo"
        src="/imagenes/logo-blanco-ee.png"
        alt="Ensurity Express Logo"
      />
      <div class="banner-title">
        <div class="banner-title-main">Ensurity Express Tax Solutions</div>
        <div class="banner-title-sub">Secure Payment Portal</div>
      </div>
    </div>
    <div class="banner-right">
      935 W RALPH HALL PKWY 101, ROCKWALL, TX 75032<br/>
      (469)484-7873
    </div>
  </div>

  <!-- Content of the HPP inside an iframe -->
  <div class="iframe-wrapper">
    <div class="iframe-inner">
      <div id="loadingBox" class="loading-box">
        <div class="loader"></div>
        <div>Preparing secure payment form...</div>
        <div style="margin-top:6px; font-size:12px; color:#777;">
          Amount: $${defaultAmount} USD
        </div>
      </div>
      <iframe id="hppFrame" name="hppFrame"></iframe>
    </div>
  </div>

  <script>
    const TOKEN = "${token}";
    const SERVER_URL = "${BASE_URL}";
    const AMOUNT = "${defaultAmount}";

    async function loadHpp() {
      const loadingBox = document.getElementById("loadingBox");
      try {
        const response = await fetch(SERVER_URL + "/api/generate-authorize-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: TOKEN, amount: AMOUNT })
        });

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Could not generate payment link.");
        }

        // We create a hidden form that POSTs to the HPP, pointing to the iframe
        const form = document.createElement("form");
        form.method = "POST";
        form.action = result.postUrl;
        form.target = "hppFrame";
        form.style.display = "none";

        const tokenInput = document.createElement("input");
        tokenInput.type = "hidden";
        tokenInput.name = "token";
        tokenInput.value = result.token;

        form.appendChild(tokenInput);
        document.body.appendChild(form);

        // Send the form to the iframe
        form.submit();

        // Hide loader when iframe finishes loading
        const frame = document.getElementById("hppFrame");
        frame.addEventListener("load", () => {
          loadingBox.style.display = "none";
        });

      } catch (error) {
        console.error("Error loading HPP:", error);
        loadingBox.innerHTML = \`
          <div class="error-box">
            <strong>❌ Error loading payment form</strong><br/>
            \${error.message}<br/>
            <button onclick="window.location.reload()">🔄 Retry</button>
          </div>
        \`;
      }
    }

    window.addEventListener("load", loadHpp);
  </script>
</body>
</html>
    `;

    res.send(html);
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
// API TO SEND PAYMENT EMAIL
// =====================================
app.post("/api/send-payment-email", async (req, res) => {
  console.log("📧 PAYMENT EMAIL SUBMISSION REQUEST");

  try {
    const { entityId, entityType, clientEmail, clientName, amount, products } = req.body;

    if (!entityId || !clientEmail) {
      return res.status(400).json({
        success: false,
        error: "Incomplete data to send email",
      });
    }

    let dealAmount = amount;
    let dealProducts = products || [];
    
    if (dealProducts.length === 0) {
      try {
        dealProducts = await bitrix24.getDealProducts(entityId);
      } catch (error) {
        console.error("Error getting products:", error);
        dealProducts = [];
      }
    }

    const token = generateSecureToken();
    const tokenData = {
      entityId,
      entityType,
      contactEmail: clientEmail,
      contactName: clientName,
      dealAmount: dealAmount,
      products: dealProducts,
      timestamp: Date.now(),
      expires: Date.now() + 24 * 60 * 60 * 1000,
      flowType: "email",
      isEmailFlow: true,
    };

    paymentTokens.set(token, tokenData);
    const paymentLink = `${BASE_URL}/payment/${token}`;

    await sendPaymentEmail(
      clientEmail,
      clientName,
      paymentLink,
      entityId,
      dealAmount,
      dealProducts
    );

    res.json({
      success: true,
      message: "Email sent successfully with products",
      clientEmail: clientEmail,
      clientName: clientName,
      entityId: entityId,
      amount: dealAmount,
      productsCount: dealProducts.length,
      flowType: "email",
      invoiceNumber: authorizeService.buildInvoiceNumber(entityId),
    });
  } catch (error) {
    console.error("❌ Error sending email:", error);
    res.status(500).json({
      success: false,
      error: "Error sending email",
      details: error.message,
    });
  }
});

// =====================================
// API TO GENERATE AUTHORIZE.NET HPP LINK
// =====================================
app.post("/api/generate-authorize-link", async (req, res) => {
  console.log("🔗 AUTHORIZE.NET HPP GENERATION REQUEST");

  try {
    const { token, amount } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token not provided",
      });
    }

    const tokenData = paymentTokens.get(token);

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired token",
      });
    }

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid amount. Must be greater than 0",
      });
    }

    console.log("🔄 Generating Authorize.Net link for:", {
      client: tokenData.contactName,
      email: tokenData.contactEmail,
      amount: amount,
      entity: `${tokenData.entityType}-${tokenData.entityId}`,
      products: tokenData.products?.length || 0,
      flowType: tokenData.flowType,
      isEmailFlow: tokenData.isEmailFlow || false,
    });

    const hppResult = await authorizeService.createHostedPaymentPage({
      amount: amount,
      customerName: tokenData.contactName,
      customerEmail: tokenData.contactEmail,
      entityId: tokenData.entityId,
      entityType: tokenData.entityType,
      products: tokenData.products || [],
      isEmailFlow: tokenData.isEmailFlow || false,
    });

    tokenData.authorizeReferenceId = hppResult.referenceId;
    tokenData.authorizeToken = hppResult.token;
    tokenData.finalAmount = amount;
    paymentTokens.set(token, tokenData);

    console.log(
      `✅ Authorize.Net reference saved: ${hppResult.referenceId} - Amount: $${amount}`
    );

    res.json({
      success: true,
      postUrl: hppResult.postUrl,
      token: hppResult.token,
      referenceId: hppResult.referenceId,
      amount: amount,
      flowType: tokenData.flowType,
      message: "Authorize.Net payment link generated successfully",
    });
  } catch (error) {
    console.error("❌ Error generating Authorize.Net link:", error.message);

    res.status(500).json({
      success: false,
      error: error.message || "Error generating payment link",
    });
  }
});

// =====================================
// API TO PROCESS PAYMENTS WITH AUTHORIZE.NET (DOESN'T CHANGE HPP)
// =====================================
app.post("/api/process-payment", async (req, res) => {
  console.log("💳 PROCESSING PAYMENT WITH AUTHORIZE.NET (REAL INTEGRATION)");

  try {
    const { token, amount, cardNumber, expiry, cvv, cardName } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token not provided",
      });
    }

    const tokenData = paymentTokens.get(token);

    if (!tokenData) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired token",
      });
    }

    console.log("🔄 Starting processing with Authorize.Net for:", {
      client: tokenData.contactName,
      email: tokenData.contactEmail,
      amount: amount,
      entity: `${tokenData.entityType}-${tokenData.entityId}`,
      products: tokenData.products?.length || 0,
      isEmailFlow: tokenData.isEmailFlow || false,
    });

    const authResult = await authorizeService.createTransaction(amount, {
      cardNumber: cardNumber,
      expiry: expiry,
      cvv: cvv,
      cardName: cardName,
      customerName: tokenData.contactName,
      customerEmail: tokenData.contactEmail,
      entityId: tokenData.entityId,
      entityType: tokenData.entityType,
      products: tokenData.products || [],
      isEmailFlow: tokenData.isEmailFlow || false,
    });

    console.log("✅ Authorize.Net Result:", authResult);

    await sendPaymentConfirmation(tokenData.contactEmail, {
      clientName: tokenData.contactName,
      amount: amount,
      transactionId: authResult.transactionId,
      authCode: authResult.authCode,
      referenceId: authResult.referenceId,
      invoiceNumber: authResult.invoiceNumber,
      entityType: tokenData.entityType,
      entityId: tokenData.entityId,
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
        UF_CRM_PRODUCTS_COUNT: tokenData.products?.length || 0,
      });
      console.log(`✅ Bitrix24 updated for deal ${tokenData.entityId}`);
    } catch (bitrixError) {
      console.error("❌ Error updating Bitrix24:", bitrixError.message);
    }

    paymentTokens.delete(token);

    res.json({
      success: true,
      message: "Payment processed successfully with Authorize.Net",
      transactionId: authResult.transactionId,
      authCode: authResult.authCode,
      referenceId: authResult.referenceId,
      invoiceNumber: authResult.invoiceNumber,
      amount: amount,
      clientEmail: tokenData.contactEmail,
      authResponse: authResult.fullResponse,
    });
  } catch (error) {
    console.error(
      "❌ Error processing payment with Authorize.Net:",
      error.message
    );

    res.status(500).json({
      success: false,
      error: "Error processing payment with Authorize.Net",
      details: error.message,
    });
  }
});

// =====================================
// AUTHORIZE.NET SILENT POST WEBHOOK
// =====================================
app.post("/api/authorize-webhook", async (req, res) => {
  console.log("🔔 AUTHORIZE.NET SILENT POST WEBHOOK RECEIVED");
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
      console.log("❌ Webhook without transaction ID");
      return res.status(400).send("Missing transaction ID");
    }

    console.log("📋 Transaction data received:", {
      transactionId: x_trans_id,
      responseCode: x_response_code,
      reason: x_response_reason_text,
      amount: x_amount,
      invoice: x_invoice_num,
      email: x_email,
    });

    if (x_response_code === "1") {
      console.log("✅ Transaction APPROVED via webhook");
    } else {
      console.log(
        "❌ Transaction DECLINED via webhook:",
        x_response_reason_text
      );
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("💥 Error processing webhook:", error);
    res.status(500).send("Error");
  }
});

// =====================================
// AUTHORIZE.NET CALLBACKS
// =====================================
app.get("/authorize/return", async (req, res) => {
  console.log("✅ Authorize.Net Return URL called (GET)");
  console.log("Query params:", req.query);

  const { transId, x_trans_id, amount, x_amount } = req.query;
  const transactionId = transId || x_trans_id;
  const transactionAmount = amount || x_amount;

  try {
    if (transactionId) {
      console.log(`🔍 Getting transaction details: ${transactionId}`);

      const transactionDetails = await authorizeService.getTransactionStatus(
        transactionId
      );
      console.log("📋 Transaction details:", transactionDetails);

      for (let [token, tokenData] of paymentTokens.entries()) {
        if (
          tokenData.authorizeReferenceId &&
          tokenData.authorizeReferenceId.includes(transactionId)
        ) {
          console.log(`✅ Token found for transaction ${transactionId}`);

          try {
            await bitrix24.updateDeal(tokenData.entityId, {
              UF_CRM_PAYMENT_STATUS: "completed",
              UF_CRM_PAYMENT_AMOUNT:
                transactionAmount || tokenData.finalAmount || "1.00",
              UF_CRM_PAYMENT_DATE: new Date().toISOString(),
              UF_CRM_TRANSACTION_ID: transactionId,
              UF_CRM_PAYMENT_PROCESSOR: "Authorize.Net",
              UF_CRM_PAYMENT_FLOW: tokenData.flowType || "unknown",
              UF_CRM_PRODUCTS_COUNT: tokenData.products?.length || 0,
            });
            console.log(
              `✅ Bitrix24 updated for deal ${tokenData.entityId}`
            );
          } catch (bitrixError) {
            console.error(
              "❌ Error updating Bitrix24:",
              bitrixError.message
            );
          }

          try {
            await sendPaymentConfirmation(tokenData.contactEmail, {
              clientName: tokenData.contactName,
              amount: transactionAmount || tokenData.finalAmount || "1.00",
              transactionId: transactionId,
              entityType: tokenData.entityType,
              entityId: tokenData.entityId,
            });
          } catch (emailError) {
            console.error("❌ Error sending email:", emailError.message);
          }

          break;
        }
      }
    }

    res.redirect(
      `${BASE_URL}/payment-success?amount=${
        transactionAmount || "0"
      }&transId=${transactionId || ""}`
    );
  } catch (error) {
    console.error("❌ Error in return URL:", error);
    res.redirect(
      `${BASE_URL}/payment-success?amount=${transactionAmount || "0"}`
    );
  }
});

app.post("/authorize/return", async (req, res) => {
  console.log("✅ Authorize.Net Return URL called (POST)");
  console.log("Body params:", req.body);

  const { x_trans_id, x_amount } = req.body;

  try {
    if (x_trans_id) {
      console.log(`🔍 Processing transaction via POST: ${x_trans_id}`);
    }

    res.redirect(
      `${BASE_URL}/payment-success?amount=${
        x_amount || "0"
      }&transId=${x_trans_id || ""}`
    );
  } catch (error) {
    console.error("❌ Error in return URL (POST):", error);
    res.redirect(`${BASE_URL}/payment-success`);
  }
});

// =====================================
// DIRECT PAYMENT FROM WEB (NO EMAIL / NO INTERMEDIATE PAGE)
// =====================================
app.get("/pay-direct", async (req, res) => {
  console.log("💳 DIRECT PAYMENT /pay-direct");

  try {
    // Optional parameters from URL
    const amountParam = req.query.amount;
    const nameParam = req.query.name;
    const referenceParam = req.query.reference;
    const descriptionParam = req.query.description;

    // Default amount if nothing is sent
    const amount =
      amountParam && parseFloat(amountParam) > 0 ? amountParam : "20.80";

    const customerName = nameParam || "Web Customer";
    const customerEmail = "webpayment@ensurityexpress.com"; // generic email
    const entityId = referenceParam || "WEB_PAYMENT";
    const entityType = "web";

    console.log("🔄 Creating direct HPP for:", {
      amount,
      customerName,
      customerEmail,
      entityId,
      entityType,
      description: descriptionParam || null,
    });

    // Create an internal token to keep tracking this session if needed
    const token = generateSecureToken();
    const tokenData = {
      entityId,
      entityType,
      contactEmail: customerEmail,
      contactName: customerName,
      dealAmount: amount,
      description: descriptionParam || null,
      timestamp: Date.now(),
      expires: Date.now() + 24 * 60 * 60 * 1000,
      flowType: "web_direct",
      isEmailFlow: false,
    };
    paymentTokens.set(token, tokenData);

    // Generate Hosted Payment Page in Authorize.Net
    const hppResult = await authorizeService.createHostedPaymentPage({
      amount,
      customerName,
      customerEmail,
      entityId,
      entityType,
      description: descriptionParam,
      isEmailFlow: false,
    });

    if (!hppResult || !hppResult.success) {
      console.error("❌ Error HPP (unexpected structure):", hppResult);
      throw new Error(
        hppResult?.error || "Could not generate payment page"
      );
    }

    // Save Authorize.Net reference in token
    tokenData.authorizeReferenceId = hppResult.referenceId;
    tokenData.authorizeToken = hppResult.token;
    tokenData.finalAmount = amount;
    paymentTokens.set(token, tokenData);

    console.log("✅ HPP generated correctly:", {
      postUrl: hppResult.postUrl,
      referenceId: hppResult.referenceId,
      amount,
      description: descriptionParam || null,
    });

    res.redirect(`/payment/${token}`);
  } catch (error) {
    console.error("💥 Error in /pay-direct:", {
      message: error.message,
      responseStatus: error.response?.status,
      responseData: error.response?.data,
    });

    res
      .status(500)
      .send("Error starting payment. Try again later.");
  }
});

// =====================================
// PAYMENT SUCCESS ROUTE
// =====================================
app.get("/payment-success", (req, res) => {
  const { amount, transId } = req.query;

  console.log(`✅ Showing success page for payment: $${amount}`);

  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Successful Payment - Ensurity Express</title>
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
        <h1>Payment Successful!</h1>
        <p>The payment has been successfully processed.</p>
        <p>A receipt has been sent to your email with all the details.</p>
        ${
          amount
            ? `
        <div class="receipt">
            <h3>📋 Payment Summary</h3>
            <p><strong>💰 Amount:</strong> $${amount}</p>
            ${
              transId
                ? `<p><strong>🔢 Transaction ID:</strong> ${transId}</p>`
                : ""
            }
            <p><strong>📅 Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>⏰ Time:</strong> ${new Date().toLocaleTimeString()}</p>
            <p><strong>🔒 Status:</strong> Completed</p>
        </div>
        `
            : ""
        }

        <p style="font-size: 12px; color: #6c757d;">
            <strong>📧 Receipt sent to your email</strong><br>
            Keep this receipt for your records.
        </p>

        <a href="${WEBSITE_URL}" class="btn-home">
            🏠 Return to EnsurityExpress.com
        </a>

        <div style="margin-top: 20px; padding-top: 18px; border-top: 1px solid #e9ecef;">
            <p style="font-size: 11px; color: #6c757d;">
                <strong>Ensurity Express Tax Solutions</strong><br>
                Secure Payment System
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
// ROUTES FOR FAILURES AND CANCELLATIONS
// =====================================
app.get("/payment-failed", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Payment Failed - Ensurity Express</title>
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
        <h1>Payment Failed</h1>
        <p>The payment could not be processed. Please try again.</p>
        <a href="javascript:history.back()" class="btn-retry">🔄 Retry Payment</a>
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
    <title>Payment Cancelled - Ensurity Express</title>
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
        <h1>Payment Cancelled</h1>
        <p>You have cancelled the payment process. You can try again whenever you wish.</p>
    </div>
</body>
</html>
  `);
});

// Optional: cancellation route used by Authorize.Net
app.get("/authorize/cancel", (req, res) => {
  res.redirect("/payment-cancelled");
});

// =====================================
// HEALTH CHECK
// =====================================
app.get("/health", (req, res) => {
  const activeSessions = Array.from(paymentTokens.entries()).map(([k, v]) => ({
    token: k.substring(0, 10) + "...",
    entity: `${v.entityType}-${v.entityId}`,
    email: v.contactEmail,
    products: v.products?.length || 0,
    flowType: v.flowType || "unknown",
    isEmailFlow: v.isEmailFlow || false,
    amount: v.dealAmount || "N/A",
    authorizeReference: v.authorizeReferenceId || "Not assigned",
    expires: new Date(v.expires).toISOString(),
  }));

  res.json({
    status: "OK",
    server: "Ensurity Express Payments v1.1",
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    websiteUrl: WEBSITE_URL,
    invoiceFormat: "EX000XL00TX (Siempre)",
    features: {
      bitrix24Products: "✓ Enabled",
      authorizeInvoiceDescription: "✓ Product-based",
      emailProductsDisplay: "✓ Enabled"
    },
    endpoints: {
      widget: "POST /widget/bitrix24",
      webhook: "POST /webhook/bitrix24",
      health: "GET /health",
      payment: "GET /payment/:token",
      paymentSuccess: "GET /payment-success",
      sendEmail: "POST /api/send-payment-email",
      processPayment: "POST /api/process-payment",
      generateAuthorizeLink: "POST /api/generate-authorize-link",
      authorizeReturn: "GET/POST /authorize/return",
      authorizeCancel: "GET /authorize/cancel",
      iframeCommunicator: "GET /iframe-communicator",
      payDirect: "GET /pay-direct",
    },
    authorize: {
      environment: authorizeService.useSandbox ? "SANDBOX" : "PRODUCTION",
      baseUrl: authorizeService.getBaseUrl(),
      hasApiLoginId: !!authorizeService.apiLoginId,
      hasTransactionKey: !!authorizeService.transactionKey,
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
// DEBUG HPP PRODUCTION
// =====================================
app.post("/api/debug-hpp-production", async (req, res) => {
  try {
    console.log("🧪 DEBUG HPP PRODUCCIÓN INICIADO");

    const testPayload = {
      getHostedPaymentPageRequest: {
        merchantAuthentication: {
          name: process.env.AUTHORIZE_API_LOGIN_ID,
          transactionKey: process.env.AUTHORIZE_TRANSACTION_KEY,
        },
        transactionRequest: {
          transactionType: "authCaptureTransaction",
          amount: "10.00",
        },
      },
    };

    console.log("📤 DEBUG - Sending to PRODUCTION:", {
      url: "https://api.authorize.net/xml/v1/request.api",
      payload: {
        ...testPayload,
        merchantAuthentication: { name: "***", transactionKey: "***" },
      },
    });

    const response = await axios.post(
      "https://api.authorize.net/xml/v1/request.api",
      testPayload,
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    console.log(
      "✅ DEBUG - PRODUCTION Response:",
      JSON.stringify(response.data, null, 2)
    );

    if (response.data.token) {
      const postUrl = "https://accept.authorize.net/payment/payment";

      res.json({
        success: true,
        token: response.data.token,
        postUrl: postUrl,
        fullResponse: response.data,
      });
    } else {
      throw new Error(
        response.data.messages?.message?.[0]?.text || "No token received"
      );
    }
  } catch (error) {
    console.error("💥 DEBUG - PRODUCTION Error:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    res.status(500).json({
      success: false,
      error: error.message,
      response: error.response?.data,
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
      <body style="font-family: Arial, sans-serif; padding: 20px; background: #f4f4f4;">
        <div style="max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1>🧪 Testing Bitrix24 Widget</h1>
          <p>Testing <strong>${testEntityType}</strong> ID: <strong>${testEntityId}</strong></p>
          <button onclick="testPost()" style="background: #af100a; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">
            Test Widget POST
          </button>
          <div id="result" style="margin-top: 20px;"></div>
        </div>
        <script>
          async function testPost() {
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<p>⏳ Loading widget...</p>';

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
// Root route
// =====================================
app.get("/", (req, res) => {
  res.json({
    message: "Ensurity Express Payments API",
    version: "1.1",
    status: "running",
    baseUrl: BASE_URL,
    websiteUrl: WEBSITE_URL,
    invoiceFormat: "EX000XL00TX (Siempre)",
    descriptionBehavior: "Product-based descriptions",
    features: [
      "Bitrix24 integration with product display",
      "Authorize.Net Hosted Payment Pages",
      "Email invoicing with product details",
      "Secure token-based payment links"
    ],
    endpoints: {
      health: "/health",
      widget: "/widget/bitrix24",
      payment: "/payment/{token}",
      debugHpp: "/api/debug-hpp-production",
      documentation: "See /health for all endpoints",
    },
  });
});

// =====================================
// Global error handling
// =====================================
app.use((err, req, res, next) => {
  console.error("💥 Global Error:", err);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    details: err.message,
  });
});

// =====================================
// Initialize server
// =====================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `🚀 Ensurity Express Payments server running on port ${PORT}`
  );
  console.log(`🔗 Base URL: ${BASE_URL}`);
  console.log(`🌐 Website: ${WEBSITE_URL}`);
  console.log(`🎯 Widget: POST ${BASE_URL}/widget/bitrix24`);
  console.log(`🔗 Webhook: POST ${BASE_URL}/webhook/bitrix24`);
  console.log(`💳 Payments: GET ${BASE_URL}/payment/{token}`);
  console.log(`✅ Success: GET ${BASE_URL}/payment-success`);
  console.log(`📧 Email: POST ${BASE_URL}/api/send-payment-email`);
  console.log(`💳 Process: POST ${BASE_URL}/api/process-payment`);
  console.log(
    `🔗 Authorize Generate: POST ${BASE_URL}/api/generate-authorize-link`
  );
  console.log(`🔧 Debug HPP: POST ${BASE_URL}/api/debug-hpp-production`);
  console.log(`↩️  Authorize Return: GET/POST ${BASE_URL}/authorize/return`);
  console.log(`❌ Authorize Cancel: GET ${BASE_URL}/authorize/cancel`);
  console.log(`🖼️  Iframe Communicator: GET ${BASE_URL}/iframe-communicator`);
  console.log(`❤️  Health: GET ${BASE_URL}/health`);
  console.log(
    `🏦 Authorize.Net: ${
      authorizeService.useSandbox ? "SANDBOX" : "PRODUCTION"
    }`
  );
  console.log(`📄 Invoice Format: EX000XL00TX (Siempre)`);
  console.log(`🛒 Product Integration: ✓ ENABLED`);
});