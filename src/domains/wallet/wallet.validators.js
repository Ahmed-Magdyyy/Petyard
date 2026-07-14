import { body, param } from "express-validator";
import { validatorMiddleware } from "../../shared/middlewares/validatorMiddleware.js";

export const adjustWalletBalanceValidator = [
  param("userId").isMongoId().withMessage("Invalid user id"),

  body("amount")
    .exists({ checkFalsy: false })
    .withMessage("amount is required")
    .bail()
    .isFloat()
    .withMessage("amount must be a number")
    .bail()
    .custom((value) => {
      if (Number(value) === 0) {
        throw new Error("amount must be a non-zero number");
      }
      return true;
    })
    .toFloat(),

  body("comment")
    .optional()
    .isString()
    .withMessage("comment must be a string")
    .bail()
    .trim()
    .isLength({ max: 500 })
    .withMessage("comment must be at most 500 characters"),

  body("comments")
    .optional()
    .isString()
    .withMessage("comments must be a string")
    .bail()
    .trim()
    .isLength({ max: 500 })
    .withMessage("comments must be at most 500 characters"),

  body().custom((_, { req }) => {
    const comment = req.body?.comment || req.body?.comments;
    if (!comment || !String(comment).trim()) {
      throw new Error("comment is required");
    }

    req.body.comment = String(comment).trim();
    return true;
  }),

  validatorMiddleware,
];
