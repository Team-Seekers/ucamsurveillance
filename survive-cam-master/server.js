const express = require("express");
const app = express();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const path = require("path");
const mongoose = require("mongoose");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const connectdb = require("./lib/db.js");
const User = require("./model/opencv.model.js"); // Your User Mongoose model
const session = require("express-session");
const flash = require("connect-flash");
const http = require("http");

// Define port number, ideally from environment variable
const port = process.env.PORT || 3000;

// --- Email Configuration ---
// IMPORTANT: Use environment variables for production!
// Ensure your Gmail account allows "App Passwords" if 2FA is on.
const emailUser = process.env.EMAIL_USER || "";
const emailPass = process.env.EMAIL_PASS || ""; 

// Nodemailer Transporter Configuration with optimizations for reliability
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: emailUser,
    pass: emailPass,
  },
  tls: {
    rejectUnauthorized: false
  },
  pool: true, 
  maxConnections: 5, 
  maxMessages: 100, 
  rateLimit: 10, 
  timeout: 30000, 
  socketTimeout: 60000, 
});

// Verify transporter connection on startup
transporter.verify(function (error, success) {
  if (error) {
    console.error("Nodemailer transporter connection failed:", error);
    console.error(
      "Possible causes: Incorrect host/port, firewall, incorrect credentials, or network issues."
    );
  } else {
    console.log("Nodemailer transporter ready to send emails");
  }
});

// --- Express App Configuration ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(
  express.urlencoded({
    extended: true,
  })
);
app.use(
  express.json({
    limit: "50mb",
  })
);
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "yourSuperSecretKey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
app.use(flash());

// Connect to MongoDB
connectdb();

function formatToE164(phoneNumber) {
  if (!phoneNumber) return null;
  let cleanedNumber = phoneNumber.replace(/[^\d+]/g, "");
  if (cleanedNumber.startsWith("+")) {
    if (/^\+[1-9]\d{1,14}$/.test(cleanedNumber)) {
      return cleanedNumber;
    }
  } else {
    const defaultCountryCode = "91";
    if (!cleanedNumber.startsWith(defaultCountryCode)) {
      cleanedNumber = defaultCountryCode + cleanedNumber;
    }
    cleanedNumber = "+" + cleanedNumber;
    if (/^\+[1-9]\d{1,14}$/.test(cleanedNumber)) {
      return cleanedNumber;
    }
  }
  console.warn(
    `Attempted to format invalid phone number: ${phoneNumber}. Result: ${cleanedNumber}`
  );
  return null;
}

app.use(async (req, res, next) => {
  if (req.session && req.session.user && req.session.user.email) {
    try {
      const user = await User.findOne({
        email: req.session.user.email,
      });

      if (user) {
        req.session.user = {
          _id: user._id,
          name: user.name,
          email: user.email,
          phonenumber: user.phonenumber,
        };
      } else {
        console.warn(
          "User email in session but user not found in database. Destroying session."
        );
        req.session.destroy(() => {
          req.session.user = {};
        });
      }
    } catch (error) {
      console.error(
        "Error fetching user from database in session middleware:",
        error
      );
      req.session.user = {};
    }
  } else {
    req.session.user = req.session.user || {};
  }
  next();
});

const isLoggedIn = (req, res, next) => {
  if (req.session.user && req.session.user._id) {
    next();
  } else {
    req.flash("messeage", {
      notify: "Please login first",
      type: "warning",
    });
    res.redirect("/login");
  }
};

// --- Routes ---
app.get("/", (req, res) => {
  if (req.session.user && req.session.user._id) {
    res.redirect("/profile");
  } else {
    res.redirect("/login");
  }
});

app.get("/login", (req, res) => {
  if (req.session.user && req.session.user._id) {
    return res.redirect("/profile");
  }
  const messeage = req.flash("messeage")[0] || {};
  res.render("regist", {
    formType: "login",
    activeTab: "login",
    messeage,
  });
});

app.get("/profile", isLoggedIn, async (req, res) => {
  const userdetails = req.session.user || {};
  if (!userdetails || !userdetails._id) {
    req.flash("messeage", {
      notify: "Please login first",
      type: "warning",
    });
    return res.redirect("/login");
  }

  sendAdminNotification(userdetails).catch((error) => {
    console.error("Error sending admin notification (non-blocking):", error);
  });

  res.render("profile", {
    userdetails,
    notificationPreferences,
    activeTimeRange,
  });
});

app.get("/signup", (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
  res.render("regist", {
    formType: "signup",
    activeTab: "signup",
    messeage,
  });
});

app.get("/forget-password", (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
  res.render("forgotPassword", {
    messeage,
  });
});

app.get("/resendotp", (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
  res.render("resendotp", {
    messeage,
  });
});

app.get("/OTP", (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
  res.render("OTP", {
    messeage,
  });
});

app.get("/reset-password", (req, res) => {
  const token = req.query.token;
  const messeage = req.flash("messeage")[0] || {};
  res.render("reset-password", {
    token,
    messeage,
  });
});

app.post("/signup", async (req, res) => {
  const { name, email, phonenumber, password, confirmpassword } = req.body;

  try {
    if (await User.findOne({ email: email })) {
      req.flash("messeage", {
        notify: "User with this email already exists",
        type: "danger",
      });
      return res.redirect("/signup");
    } else if (password !== confirmpassword) {
      req.flash("messeage", {
        notify: "Password does not match",
        type: "danger",
      });
      return res.redirect("/signup");
    }

    const formattedPhonenumber = formatToE164(phonenumber);
    if (!formattedPhonenumber) {
      req.flash("messeage", {
        notify:
          "Invalid phone number format. Please include country code (e.g., +91).",
        type: "danger",
      });
      return res.redirect("/signup");
    }

    const OTP = crypto.randomBytes(2).toString("hex").toLowerCase();
    const otpexpiry = new Date(Date.now() + 3600000);

    const emailSent = await sendOTPEmail(email, OTP);
    if (!emailSent) {
      req.flash("messeage", {
        notify:
          "Failed to send OTP. Please check your email settings or try again.",
        type: "danger",
      });
      return res.redirect("/signup");
    }

    const hashedpassword = await bcrypt.hash(password, 10);
    const newuser = new User({
      name,
      email,
      phonenumber: formattedPhonenumber,
      password: hashedpassword,
      otp: OTP,
      otpexpiry,
      otpverify: false,
    });
    await newuser.save();

    req.flash("messeage", {
      notify: "OTP sent to your email for verification.",
      type: "success",
    });
    res.redirect("/OTP");
  } catch (err) {
    console.error("Error during signup:", err);
    req.flash("messeage", {
      notify: "An error occurred during signup.",
      type: "danger",
    });
    res.redirect("/signup");
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({
      email: email,
    });

    if (!user) {
      req.flash("messeage", {
        notify: "User not found",
        type: "danger",
      });
      return res.redirect("/login");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      req.flash("messeage", {
        notify: "Invalid Password",
        type: "danger",
      });
      return res.redirect("/login");
    }

    if (!user.otpverify) {
      const newOTP = crypto.randomBytes(2).toString("hex").toLowerCase();
      const newOtpexpiry = new Date(Date.now() + 3600000);

      const emailSent = await sendOTPEmail(user.email, newOTP);
      if (!emailSent) {
        req.flash("messeage", {
          notify:
            "Failed to send new OTP. Please try again or check your email settings.",
          type: "danger",
        });
        return res.redirect("/login");
      }

      user.otp = newOTP;
      user.otpexpiry = newOtpexpiry;
      await user.save();

      req.flash("messeage", {
        notify:
          "Please verify your account with OTP first. A new OTP has been sent to your email.",
        type: "warning",
      });
      return res.redirect("/OTP");
    }

    req.session.user = {
      _id: user._id,
      name: user.name,
      email: user.email,
      phonenumber: user.phonenumber,
    };
    req.flash("userInfo", {
      name: user.name,
      email: user.email,
      phonenumber: user.phonenumber,
    });
    return res.redirect("/profile");
  } catch (err) {
    console.error("Error during login:", err);
    req.flash("messeage", {
      notify: "An error occurred during login.",
      type: "danger",
    });
    res.redirect("/login");
  }
});

app.post("/forget-password", async (req, res) => {
  const email = req.body.email;
  try {
    const user = await User.findOne({
      email: email,
    });
    if (!user) {
      req.flash("messeage", {
        notify: "User not found",
        type: "danger",
      });
      return res.redirect("/forget-password");
    }

    const token = crypto.randomBytes(32).toString("hex");
    user.resetexpiry = new Date(Date.now() + 3600000);
    user.resettoken = token;
    await user.save();

    try {
      await transporter.sendMail({
        from: emailUser,
        to: email,
        subject: "uCam Password Reset Request",
        html: `<h1>Click here to reset your password: <a href="http://localhost:${port}/reset-password?token=${token}">Reset Password</a></h1><p>This link is valid for 1 hour.</p>`,
      });
      console.log("Reset password email sent successfully.");
    } catch (emailError) {
      console.error("Error sending reset password email:", emailError.message);
      req.flash("messeage", {
        notify: "Failed to send reset email. Please try again.",
        type: "danger",
      });
      return res.redirect("/forget-password");
    }

    req.flash("messeage", {
      notify: "Reset password link sent to your email successfully",
      type: "success",
    });
    return res.redirect("/forget-password");
  } catch (err) {
    console.error("Error during forget password:", err);
    req.flash("messeage", {
      notify: "An error occurred.",
      type: "danger",
    });
    res.redirect("/forget-password");
  }
});

app.post("/reset-password", async (req, res) => {
  const { password, confirmPassword, token } = req.body;
  try {
    if (password !== confirmPassword) {
      req.flash("messeage", {
        notify: "Passwords do not match",
        type: "danger",
      });
      return res.redirect(`/reset-password?token=${token}`);
    }

    const user = await User.findOne({
      resettoken: token,
      resetexpiry: {
        $gt: Date.now(),
      },
    });

    if (!user) {
      req.flash("messeage", {
        notify: "Invalid or expired reset token",
        type: "danger",
      });
      return res.redirect("/forget-password");
    }

    const hashedpassword = await bcrypt.hash(password, 10);
    user.password = hashedpassword;
    user.resettoken = undefined;
    user.resetexpiry = undefined;
    await user.save();

    console.log("Password updated successfully for user:", user.email);
    req.flash("messeage", {
      notify: "Password updated successfully! Please login.",
      type: "success",
    });
    res.redirect("/login");
  } catch (err) {
    console.error("Error during password reset:", err);
    req.flash("messeage", {
      notify: "An error occurred during password reset.",
      type: "danger",
    });
    res.redirect(`/reset-password?token=${token}`);
  }
});

app.post("/OTP", async (req, res) => {
  const otp = req.body.otp ? req.body.otp.trim().toLowerCase() : "";
  try {
    const user = await User.findOne({
      otp: otp,
    });

    if (!user) {
      req.flash("messeage", {
        notify: "Incorrect OTP",
        type: "danger",
      });
      return res.redirect("/OTP");
    }

    if (user.otpexpiry < Date.now()) {
      req.flash("messeage", {
        notify: "OTP has expired",
        type: "danger",
      });
      return res.redirect("/OTP");
    }

    user.otpverify = true;
    user.otpexpiry = undefined;
    user.otp = undefined;
    await user.save();

    console.log("OTP verified successfully for user:", user.email);
    req.session.user = {
      _id: user._id,
      email: user.email,
      name: user.name,
      phonenumber: user.phonenumber,
    };
    req.flash("messeage", {
      notify: "Account verified successfully! Welcome.",
      type: "success",
    });
    return res.redirect("/profile");
  } catch (err) {
    console.error("Error during OTP verification:", err);
    req.flash("messeage", {
      notify: "An error occurred during OTP verification.",
      type: "danger",
    });
    res.redirect("/OTP");
  }
});

app.post("/resendotp", async (req, res) => {
  const email = req.body.email;
  try {
    const user = await User.findOne({ email: email });
    if (!user) {
      req.flash("messeage", {
        notify: "User not found",
        type: "danger",
      });
      return res.redirect("/resendotp");
    }

    const OTP = crypto.randomBytes(2).toString("hex").toLowerCase();
    const otpexpiry = new Date(Date.now() + 3600000);

    const emailSent = await sendOTPEmail(email, OTP);
    if (!emailSent) {
      req.flash("messeage", {
        notify: "Failed to send new OTP. Please try again.",
        type: "danger",
      });
      return res.redirect("/resendotp");
    }

    user.otp = OTP;
    user.otpexpiry = otpexpiry;
    await user.save();

    req.flash("messeage", {
      notify: "New OTP sent to your email.",
      type: "success",
    });
    return res.redirect("/OTP");
  } catch (err) {
    console.error("Error during resend OTP:", err);
    req.flash("messeage", {
      notify: "An error occurred while resending OTP.",
      type: "danger",
    });
    res.redirect("/resendotp");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
    }
    res.redirect("/login");
  });
});


app.post("/api/update-user-contact", isLoggedIn, async (req, res) => {
  const { field, value } = req.body;

  if (!req.session.user || !req.session.user._id) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: User not logged in or ID missing.",
    });
  }

  try {
    const user = await User.findById(req.session.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (field === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return res.status(400).json({
          success: false,
          message: "Invalid email format.",
        });
      }
      user.email = value;
    } else if (field === "phonenumber") {
      const formattedPhonenumber = formatToE164(value);
      if (!formattedPhonenumber) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid phone number format. Please include country code (e.g., +91).",
        });
      }
      user.phonenumber = formattedPhonenumber;
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid field for update.",
      });
    }

    await user.save();

    req.session.user[field] = user.phonenumber;

    res.json({
      success: true,
      message: `${field} updated successfully.`,
      updatedValue: user.phonenumber,
    });
  } catch (error) {
    console.error(`Error updating user ${field}:`, error);
    res.status(500).json({
      success: false,
      message: `Server error updating ${field}.`,
    });
  }
});

if (require.main === module) {
  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

module.exports = app;

async function sendOTPEmail(email, OTP) {
  const emailBody = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px; background-color: #ffffff;">
      <div style="background: linear-gradient(135deg, #4a90e2 0%, #357abd 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center; margin: -20px -20px 20px -20px;">
        <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600; letter-spacing: 0.5px;">uCam Security</h1>
        <p style="color: rgba(255, 255, 255, 0.9); margin: 10px 0 0 0; font-size: 16px;">Verification Code</p>
      </div>

      <div style="padding: 20px 0;">
        <p style="font-size: 16px; line-height: 1.6; color: #333; margin-bottom: 25px;">
          Thank you for choosing uCam Security. To complete your verification, please use the following One-Time Password (OTP):
        </p>

        <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding: 25px; border-radius: 8px; margin: 30px 0; text-align: center; border: 1px solid #e0e0e0;">
          <p style="margin: 0 0 15px 0; color: #666; font-size: 14px;">Your Verification Code</p>
          <div style="background-color: white; padding: 15px; border-radius: 6px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <span style="font-size: 36px; font-weight: bold; color: #4a90e2; letter-spacing: 8px; font-family: 'Courier New', monospace;">${OTP}</span>
          </div>
        </div>

        <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; border-radius: 4px; margin: 25px 0;">
          <p style="margin: 0; color: #856404; font-size: 14px;">
            <strong>Important:</strong> This OTP is valid for 1 hour. Please do not share this code with anyone.
          </p>
        </div>
      </div>

      <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
        <p style="color: #666; font-size: 13px; margin: 0 0 10px 0;">
          This is an automated message, please do not reply to this email.
        </p>
        <p style="color: #999; font-size: 12px; margin: 0;">
          © ${new Date().getFullYear()} uCam Security. All rights reserved.
        </p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: emailUser,
      to: email,
      subject: "Your uCam Security Verification Code",
      html: emailBody,
    });
    console.log("OTP email sent successfully to:", email);
    return true;
  } catch (error) {
    console.error("Error sending OTP email to", email, ":", error.message);
    if (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEOUT") {
      console.error(
        "Email sending timed out. Check network or SMTP server settings (host, port, firewall, app password)."
      );
    } else if (error.code === "EENVELOPE" || error.code === "EAUTH") {
      console.error(
        "Email authentication or recipient error. Check credentials or recipient email address."
      );
    }
    return false;
  }
}

async function sendAdminNotification(userDetails) {
  const adminEmail = "pknodeserver@gmail.com";
  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
      <div style="background-color: #4a90e2; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
        <h2 style="color: white; margin: 0;">New User Profile Access</h2>
      </div>
      <div style="margin-bottom: 20px;">
        <p style="font-size: 16px; line-height: 1.5; color: #333;">
          A user has accessed their profile page.
        </p>
      </div>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
        <p style="margin: 0; color: #666;">
          <strong>User Name:</strong> ${userDetails.name}
        </p>
        <p style="margin: 5px 0 0 0; color: #666;">
          <strong>User Email:</strong> ${userDetails.email}
        </p>
        <p style="margin: 5px 0 0 0; color: #666;">
          <strong>Phone Number:</strong> ${userDetails.phonenumber}
        </p>
        <p style="margin: 5px 0 0 0; color: #666;">
          <strong>Access Time:</strong> ${new Date().toLocaleString()}
        </p>
      </div>
      <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
        <p style="color: #666; font-size: 14px;">
          This is an automated notification from uCam Security System.
        </p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: emailUser,
      to: adminEmail,
      subject: "New User Profile Access - uCam Security",
      html: emailBody,
    });
    console.log("Admin notification sent successfully to", adminEmail);
    return true;
  } catch (error) {
    console.error(
      "Error sending admin notification to",
      adminEmail,
      ":",
      error.message
    );
    if (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEOUT") {
      console.error(
        "Admin email sending timed out. Check network or SMTP server."
      );
    } else if (error.code === "EENVELOPE" || error.code === "EAUTH") {
      console.error(
        "Admin email authentication or recipient error. Check credentials or admin email address."
      );
    }
    }
    return false;
  }
}

// Start server locally or export for Vercel
if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
