import { Request, Response } from "express";
import { ok, fail } from "../utils/http"; // adjust path if needed

// In-memory storage (replace with DB in production)
let wishlistUsers: string[] = [];

// Add email to wishlist
export const createWishlist = (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json(fail("Email is required", "EMAIL_REQUIRED"));
    }

    // Prevent duplicates
    if (wishlistUsers.includes(email)) {
      return res
        .status(409)
        .json(fail("Email already in wishlist", "EMAIL_EXISTS"));
    }

    wishlistUsers.push(email);
    return res.status(201).json(ok({ message: "Email added to wishlist", email }));
  } catch (error) {
    return res.status(500).json(fail("Server error", "SERVER_ERROR"));
  }
};

// Get all wishlist emails
export const wishlist = (_req: Request, res: Response) => {
  return res.status(200).json(ok({ users: wishlistUsers }));
};
